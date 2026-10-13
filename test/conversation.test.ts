import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipeline, group, owner, type Incoming } from "../src/conversation.ts";
import { createOutbound } from "../src/outbound.ts";
import { AuthError, RateLimitError } from "../src/errors.ts";
import { SLOW_REPLY_MS } from "../src/quote.ts";
import type { IncomingMessage, IncomingReaction } from "@ted-personal-assistant/signal";
import { MAX_SPOKEN_CHARS } from "@ted-personal-assistant/signal";

// The shared conversation pipeline against a fake Signal client. The first block pins the owner's private chat
// exactly as it behaved when it lived in main.ts; the second shows groups get the same machinery.

const OWNER = "+10000000000";
const ACCOUNT = "+10000000001";

interface Rig {
  sent: { text: string; styles: string[]; quote?: any; groupId?: string; attachments?: string[] }[];
  reacts: { emoji: string; target: { author: string; timestamp: number }; groupId?: string }[];
  typing: { stop: boolean; groupId?: string }[];
  reads: { ts: number; from?: string }[];
  records: { groupId?: string; kind: string; text: string }[];
  prompts: string[];
  spoken: string[];
}

function rig(over: { separate?: boolean; run?: (prompt: string, own?: string) => Promise<string>; ready?: boolean; approval?: any; reactionApproval?: string; transcript?: (m: IncomingMessage) => Promise<string>; now?: () => number; vouch?: boolean; wait?: (ms: number) => Promise<void>; synth?: (words: string) => Promise<string>; admitGroup?: any; settleMs?: number; settleMaxMs?: number } = {}) {
  const r: Rig = { sent: [], reacts: [], typing: [], reads: [], records: [], prompts: [], spoken: [] };
  let ts = 5000;
  const signal = {
    separateAccount: over.separate ?? true,
    react: async (emoji: string, target: any, groupId?: string) => void r.reacts.push({ emoji, target, groupId }),
    typing: async (stop = false, groupId?: string) => void r.typing.push({ stop, groupId }),
    markRead: async (t: number, from?: string) => void r.reads.push({ ts: t, from }),
    send: async (text: string, styles: string[] = [], quote?: unknown, opts: { groupId?: string; attachments?: string[] } = {}) => (r.sent.push({ text, styles, quote, groupId: opts.groupId, attachments: opts.attachments }), ++ts),
  };
  const record = (groupId: string | undefined, kind: string, _ts: number, text: string) => void r.records.push({ groupId, kind, text });
  const out = createOutbound(signal as any, (kind, t, text, groupId) => record(groupId, kind, t, text));
  const dir = mkdtempSync(join(tmpdir(), "tts-"));
  const pipeline = createPipeline({
    signal: signal as any,
    out,
    record,
    account: ACCOUNT,
    runOwner: async (prompt, own) => (r.prompts.push(prompt), { text: await (over.run ?? (async () => "ok"))(prompt, own), costUsd: 0.01 }),
    transcript: over.transcript ?? (async () => "what is on today"),
    speech: {
      ready: () => over.ready ?? false,
      synth: over.synth ?? (async (words) => (r.spoken.push(words), writeFileSync(join(dir, "v.wav"), "x"), join(dir, "v.wav"))),
    },
    approvals: { answer: async (text: string) => (typeof over.approval === "function" ? over.approval(text) : over.approval) ?? { outcome: "none" }, answerReaction: () => over.reactionApproval ?? "ignored" },
    vouch: async () => over.vouch ?? true,
    isOwner: (w) => w.from === OWNER,
    admitGroup: over.admitGroup ?? (async () => {}),
    now: over.now,
    wait: over.wait ?? (async () => {}),
    settleMs: over.settleMs === undefined ? undefined : () => over.settleMs!,
    settleMaxMs: over.settleMaxMs === undefined ? undefined : () => over.settleMaxMs!,
  });
  return { r, pipeline };
}

const msg = (over: Partial<IncomingMessage> = {}): Incoming => ({ type: "message", m: { from: OWNER, text: "hi", timestamp: 111, direct: true, ...over } });
const react = (over: Partial<IncomingReaction> = {}): Incoming => ({ type: "reaction", r: { from: OWNER, emoji: "👍", targetTimestamp: 42, isRemove: false, direct: true, ...over } });
const target = { author: OWNER, timestamp: 111 };

test("conversation: only the two factories make conversations, and they differ in trust", () => {
  const o = owner();
  const g = group("abc");
  assert.deepEqual([o.source, o.gate, o.approvals, o.groupId], ["chat", false, true, undefined]);
  assert.deepEqual([g.source, g.gate, g.approvals, g.groupId], ["group", true, false, "abc"]);
  assert.notEqual(g.logFile, o.logFile);
  assert.notEqual(g.notesDir, o.notesDir);
  assert.equal(owner(), o); // one owner conversation
  assert.throws(() => ((o as any).source = "group"), TypeError); // frozen: trust cannot be rewritten
});

test("private chat: a plain answer, no thread, read receipt, typing on and off, both sides logged", async () => {
  const { r, pipeline } = rig({ run: async () => "You have two meetings." });
  await pipeline.handleIncoming(owner(), msg());
  assert.deepEqual(r.sent.map((s) => [s.text, s.quote, s.groupId]), [["You have two meetings.", undefined, undefined]]);
  assert.deepEqual(r.reads, [{ ts: 111, from: undefined }]);
  assert.deepEqual(r.typing, [{ stop: false, groupId: undefined }, { stop: true, groupId: undefined }]);
  assert.deepEqual(r.records.map((x) => x.kind), ["owner", "chat"]);
  assert.deepEqual(r.reacts, []); // own account: no status icons, typing says it
  assert.equal(r.prompts[0], "hi");
});

test("private chat in Note to Self: status icons 👀 then ✅ on the owner's message, no typing", async () => {
  const { r, pipeline } = rig({ separate: false });
  await pipeline.handleIncoming(owner(), msg());
  assert.deepEqual(r.reacts.map((x) => [x.emoji, x.target]), [["👀", target], ["✅", target]]);
  assert.deepEqual(r.typing.map((t) => t.stop), [false, true]); // the client ignores it in Note to Self
});

test("private chat: threaded under the message only when it was a reply or the answer was slow", async () => {
  const quoted = rig();
  await quoted.pipeline.handleIncoming(owner(), msg({ text: "yes do that", quote: { text: "Move standup?", author: ACCOUNT, timestamp: 7 } }));
  assert.deepEqual(quoted.r.sent[0]!.quote, { text: "yes do that", author: OWNER, timestamp: 111 });
  assert.match(quoted.r.prompts[0]!, /<quoted_message>[\s\S]*Move standup\?[\s\S]*<\/quoted_message>\n\nyes do that$/);

  let t = 1_000_000;
  const slow = rig({ now: () => t, run: async () => ((t += SLOW_REPLY_MS + 1), "late") });
  await slow.pipeline.handleIncoming(owner(), msg({ text: "q".repeat(300) }));
  assert.equal(slow.r.sent[0]!.quote.text.length, 200);

  const quick = rig({ now: () => t });
  await quick.pipeline.handleIncoming(owner(), msg());
  assert.equal(quick.r.sent[0]!.quote, undefined);
});

test("private chat: [[react]] alone reacts and sends nothing; with words it does both and replaces ✅", async () => {
  const alone = rig({ run: async () => "[[react: 👍]]" });
  await alone.pipeline.handleIncoming(owner(), msg());
  assert.equal(alone.r.sent.length, 0);
  assert.deepEqual(alone.r.reacts.map((x) => x.emoji), ["👍"]);
  const both = rig({ separate: false, run: async () => "[[react: 😂]] ha, good one" });
  await both.pipeline.handleIncoming(owner(), msg());
  assert.deepEqual(both.r.sent.map((s) => s.text), ["ha, good one"]);
  assert.deepEqual(both.r.reacts.map((x) => x.emoji), ["👀", "😂"]); // the model's emoji, not ✅
});

test("private chat: [[silent]] and an empty answer send nothing", async () => {
  for (const reply of ["[[silent]]", "  [[SILENT]]  ", ""]) {
    const { r, pipeline } = rig({ run: async () => reply });
    await pipeline.handleIncoming(owner(), msg());
    assert.equal(r.sent.length, 0, reply);
    assert.deepEqual(r.typing.map((t) => t.stop), [false, true]);
  }
});

test("private chat: a voice message is transcribed (and the model may answer by voice)", async () => {
  const seen = rig({ ready: true, run: async () => "[[voice]] Two meetings today." });
  await seen.pipeline.handleIncoming(owner(), msg({ text: "", audio: { id: "a.aac", size: 10 } }));
  assert.match(seen.r.prompts[0]!, /^\[Voice message, transcribed automatically, so words may be misheard\] what is on today\n\nVoice: you may answer by voice/);
  assert.deepEqual(seen.r.spoken, ["Two meetings today."]);
  assert.equal(seen.r.sent.length, 1);
  assert.deepEqual([seen.r.sent[0]!.text, seen.r.sent[0]!.attachments?.length, seen.r.sent[0]!.groupId], ["", 1, undefined]);
  assert.deepEqual(seen.r.records.map((x) => x.text), ["🎙️ what is on today", "🔊 Two meetings today."]);
  assert.deepEqual(seen.r.reads, [{ ts: 111, from: undefined }]);
});

test("private chat: the voice option is offered with ANY message when speech is set up, typed or spoken; never without speech", async () => {
  const typed = rig({ ready: true, run: async () => "[[voice]] You've got this, coach" });
  await typed.pipeline.handleIncoming(owner(), msg({ text: "I need a pep talk" }));
  assert.match(typed.r.prompts[0]!, /^I need a pep talk\n\nVoice: you may answer by voice/);
  assert.deepEqual(typed.r.spoken, ["You've got this, coach"]);
  const mute = rig({ ready: false });
  await mute.pipeline.handleIncoming(owner(), msg({ text: "hello" }));
  assert.equal(mute.r.prompts[0], "hello");
});

test("private chat: voice falls back to text when speech is off, too long, or fails; no invitation without speech", async () => {
  const off = rig({ ready: false, run: async () => "[[voice]] Hello there" });
  await off.pipeline.handleIncoming(owner(), msg({ text: "", audio: { id: "a.aac", size: 10 } }));
  assert.doesNotMatch(off.r.prompts[0]!, /answer by voice/);
  assert.deepEqual(off.r.sent.map((s) => s.text), ["Hello there"]);
  const long = rig({ ready: true, run: async () => `[[voice]] ${"word ".repeat(MAX_SPOKEN_CHARS / 5 + 10)}` });
  await long.pipeline.handleIncoming(owner(), msg());
  assert.equal(long.r.spoken.length, 0);
  assert.equal(long.r.sent.length, 1);
  const broken = rig({ ready: true, synth: async () => { throw new Error("no tts"); }, run: async () => "[[voice]] Hello there" });
  await broken.pipeline.handleIncoming(owner(), msg());
  assert.deepEqual(broken.r.sent.map((s) => s.text), ["Hello there\n\n(voice didn't work this time, sending text)"]); // a failed speech says so: the model may have announced a voice message
  assert.deepEqual(off.r.sent.map((s) => s.text), ["Hello there"]); // no speech set up: no such note
  assert.deepEqual(long.r.sent.map((s) => s.text.includes("voice didn't work")), [false]);
});

test("private chat: a voice message that cannot be understood is explained, and a spoken yes is never an approval", async () => {
  const bad = rig({ separate: false, transcript: async () => { throw new Error("I couldn't hear any words in that voice message."); } });
  await bad.pipeline.handleIncoming(owner(), msg({ text: "", audio: { id: "a.aac", size: 10 } }));
  assert.deepEqual(bad.r.sent.map((s) => s.text), ["I couldn't hear any words in that voice message."]);
  assert.deepEqual(bad.r.reacts.map((x) => x.emoji), ["👂", "⚠️"]);
  assert.equal(bad.r.prompts.length, 0);
  const yes = rig({ approval: { outcome: "approved" }, transcript: async () => "yes" });
  await yes.pipeline.handleIncoming(owner(), msg({ text: "", audio: { id: "a.aac", size: 10 } }));
  assert.equal(yes.r.prompts.length, 1); // skipped the approval check, went to the chat
});

test("private chat: an approval answer is handled before the queue and never reaches the chat", async () => {
  const { r, pipeline } = rig({ approval: { outcome: "approved" } });
  await pipeline.handleIncoming(owner(), msg({ text: "yes" }));
  assert.equal(r.prompts.length, 0);
  assert.deepEqual(r.reacts.map((x) => x.emoji), ["👍"]);
  const modified = rig({ approval: { outcome: "modified", changes: [{ field: "start", value: "15:00" }] } });
  await modified.pipeline.handleIncoming(owner(), msg({ text: "make it 3" }));
  assert.deepEqual(modified.r.sent.map((s) => s.text), ["Applied your change: start → 15:00"]);
});

test("private chat: a failed turn becomes a notice (login, limit, other), ⚠️, and typing stops", async () => {
  for (const [err, re] of [[new AuthError("a"), /claude auth login/], [new RateLimitError("r"), /usage limit/], [new Error("secret detail"), /Something broke on my end/]] as const) {
    const { r, pipeline } = rig({ separate: false, run: async () => { throw err; } });
    await pipeline.handleIncoming(owner(), msg());
    assert.match(r.sent[0]!.text, re);
    assert.doesNotMatch(r.sent[0]!.text, /secret detail/);
    assert.deepEqual(r.reacts.map((x) => x.emoji), ["👀", "⚠️"]);
    assert.equal(r.typing.at(-1)!.stop, true);
  }
  // not rate limited in the private chat: every failure is reported
  const { r, pipeline } = rig({ run: async () => { throw new Error("x"); } });
  await pipeline.handleIncoming(owner(), msg());
  await pipeline.handleIncoming(owner(), msg({ timestamp: 112 }));
  assert.equal(r.sent.length, 2);
});

// A settling pause the test releases by hand.
const hold = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { wait: () => gate, release };
};
const tick = () => new Promise((r) => setTimeout(r, 5));

test("private chat: a burst of three messages is ONE run, oldest first, each with its own quote and voice marks", async () => {
  const h = hold();
  const { r, pipeline } = rig({ wait: h.wait, run: async () => "got all three" });
  const q = { text: "Move standup?", author: ACCOUNT, timestamp: 7 };
  const all = [
    pipeline.handleIncoming(owner(), msg({ text: "one", timestamp: 111 })),
    pipeline.handleIncoming(owner(), msg({ text: "", timestamp: 112, audio: { id: "a.aac", size: 3 } })), // transcribed: "what is on today"
    pipeline.handleIncoming(owner(), msg({ text: "three", timestamp: 113, quote: q })),
  ];
  await tick();
  assert.equal(r.prompts.length, 0); // still settling
  h.release();
  await Promise.all(all);
  assert.equal(r.prompts.length, 1);
  const p = r.prompts[0]!;
  assert.match(p, /3 messages[\s\S]*oldest first/);
  assert.ok(p.indexOf("one") < p.indexOf("what is on today") && p.indexOf("what is on today") < p.indexOf("three"));
  assert.match(p, /\[Voice message, transcribed automatically[^\]]*\] what is on today/);
  assert.equal(p.match(/Voice message, transcribed/g)?.length, 1); // only the voice one
  assert.match(p, /<quoted_message>[\s\S]*Move standup\?[\s\S]*<\/quoted_message>\n\nthree/);
  assert.deepEqual(r.sent.map((s) => [s.text, s.quote]), [["got all three", { text: "three", author: OWNER, timestamp: 113 }]]); // one answer, threaded: one of them was a reply
  assert.equal(r.records.filter((x) => x.kind === "owner").length, 3); // all remembered
});

test("private chat: a lone message is the prompt itself", async () => {
  const { r, pipeline } = rig();
  await pipeline.handleIncoming(owner(), msg({ text: "just this" }));
  assert.deepEqual(r.prompts, ["just this"]);
});

test("private chat: a run in progress finishes and sends; messages that arrive meanwhile are the next turn, together", async () => {
  let finish!: () => void;
  const first = new Promise<void>((r) => (finish = r));
  let n = 0;
  const { r, pipeline } = rig({ run: async (p) => { if (++n === 1) await first; return `answer to: ${p.replace(/\s+/g, " ").slice(0, 60)}`; } });
  const a = pipeline.handleIncoming(owner(), msg({ text: "one", timestamp: 111 }));
  await tick();
  assert.equal(r.prompts.length, 1);
  const b = pipeline.handleIncoming(owner(), msg({ text: "two", timestamp: 112 }));
  const c = pipeline.handleIncoming(owner(), msg({ text: "three", timestamp: 113 }));
  await tick();
  assert.equal(r.prompts.length, 1); // one at a time: they wait
  finish();
  await Promise.all([a, b, c]);
  assert.equal(r.prompts.length, 2);
  assert.equal(r.prompts[0], "one");
  assert.match(r.prompts[1]!, /2 messages[\s\S]*two[\s\S]*three/);
  assert.equal(r.sent.length, 2); // the first run was not cancelled
  assert.match(r.sent[0]!.text, /answer to: one/);
});

test("private chat: approval answers skip the settling pause and the burst; a spoken yes is no approval", async () => {
  const h = hold();
  const { r, pipeline } = rig({ wait: h.wait, approval: (text: string) => ({ outcome: text === "yes" ? "approved" : "none" }) });
  const a = pipeline.handleIncoming(owner(), msg({ text: "check my calendar", timestamp: 111 }));
  await pipeline.handleIncoming(owner(), msg({ text: "yes", timestamp: 112 })); // returns while the burst is still settling
  assert.deepEqual(r.reacts.map((x) => x.emoji), ["👍"]);
  assert.equal(r.prompts.length, 0);
  h.release();
  await a;
  assert.deepEqual(r.prompts, ["check my calendar"]); // the "yes" is not part of the prompt
  const spoken = rig({ approval: { outcome: "approved" }, transcript: async () => "yes" });
  await spoken.pipeline.handleIncoming(owner(), msg({ text: "", audio: { id: "a.aac", size: 3 } }));
  assert.equal(spoken.r.prompts.length, 1); // a voice "yes" is a message, not an approval
});

test("groups: a burst is one run through the shared burst; messages during a run wait for the next one", async () => {
  const h = hold();
  const runs: number[] = [];
  let finish!: () => void;
  const first = new Promise<void>((r) => (finish = r));
  const { pipeline } = rig({ wait: h.wait });
  const conv = group(GID);
  const send = (n: number) => pipeline.burst(conv, n, (b) => b.run(async (items) => { runs.push(items.length); if (runs.length === 1) await first; }));
  const all = [send(1), send(2), send(3)];
  await tick();
  assert.deepEqual(runs, []);
  h.release();
  await tick();
  assert.deepEqual(runs, [3]); // one run for three
  const later = [send(4), send(5)]; // the settle gate is already open: they queue behind the run in progress
  await tick();
  assert.deepEqual(runs, [3]);
  finish();
  await Promise.all([...all, ...later]);
  assert.deepEqual(runs, [3, 2]);
});

test("bursts: continuous chatter cannot restart the pause forever; after the maximum the burst is answered and later messages make the next turn", async () => {
  let clock = 0;
  const waits: { ms: number; release: () => void }[] = [];
  const { pipeline } = rig({ now: () => clock, settleMs: 2000, settleMaxMs: 10_000, wait: (ms) => new Promise<void>((release) => waits.push({ ms, release })) });
  const conv = owner();
  const runs: number[][] = [];
  const send = (n: number) => pipeline.burst(conv, n, (b) => b.run(async (items) => void runs.push(items)));
  const all: Promise<void>[] = [];
  for (let i = 1; i <= 6; i++) { // a message every 1.9 s: never quiet for the full 2 s pause
    all.push(send(i));
    clock += 1900;
  }
  assert.deepEqual(waits.map((w) => w.ms), [2000, 2000, 2000, 2000, 2000, 500]); // the pause restarts each time (shrinking near the cap)...
  all.push(send(7)); // 11.4 s since the first message: the cap leaves no wait at all
  assert.equal(waits[6]!.ms, 0);
  waits[6]!.release();
  await tick();
  assert.deepEqual(runs, [[1, 2, 3, 4, 5, 6, 7]]); // ...but the cap forces the run: it takes everything so far
  for (const w of waits) w.release();
  clock += 100;
  const next = send(8); // a new burst starts its own clock
  assert.equal(waits[7]!.ms, 2000);
  waits[7]!.release();
  await Promise.all([...all, next]);
  assert.deepEqual(runs, [[1, 2, 3, 4, 5, 6, 7], [8]]);
});

test("bursts: the pause is shortened to what is left of the maximum", async () => {
  let clock = 0;
  const waits: number[] = [];
  const { pipeline } = rig({ now: () => clock, settleMs: 2000, settleMaxMs: 10_000, wait: async (ms) => void waits.push(ms) });
  const conv = owner();
  void pipeline.burst(conv, 1, async () => {});
  clock = 9000;
  void pipeline.burst(conv, 2, async () => {});
  await tick();
  assert.deepEqual(waits, [2000, 1000]);
});

test("private chat: the owner's reaction is feedback the model judges; it may react back or say something, never apologises", async () => {
  const { r, pipeline } = rig({ run: async () => "[[react: ❤️]] glad it helped" });
  await pipeline.handleIncoming(owner(), react({ targetAuthor: ACCOUNT }));
  assert.match(r.prompts[0]!, /reacted 👍 to a message that is no longer in your log/);
  assert.deepEqual(r.reacts.map((x) => [x.emoji, x.target]), [["❤️", { author: ACCOUNT, timestamp: 42 }]]);
  assert.deepEqual(r.sent.map((s) => [s.text, s.quote]), [["glad it helped", undefined]]);
  assert.deepEqual(r.typing, []); // a reaction is not a conversation turn
  assert.ok(r.records.some((x) => x.kind === "reaction" && /^👍 on:/.test(x.text)));
  const broken = rig({ run: async () => { throw new Error("x"); } });
  await broken.pipeline.handleIncoming(owner(), react());
  assert.equal(broken.r.sent.length, 0);
  const silent = rig({ run: async () => "" });
  await silent.pipeline.handleIncoming(owner(), react());
  assert.equal(silent.r.sent.length + silent.r.reacts.length, 0);
  const approval = rig({ reactionApproval: "approved" });
  await approval.pipeline.handleIncoming(owner(), react());
  assert.equal(approval.r.prompts.length, 0); // 👍 on a pending "Approve?" answers it
});

// ---- groups use the same code, aimed at the group ----

const GID = "Z3JvdXAtZm9yLXRlc3Q=";
const gmsg = (over: Partial<IncomingMessage> = {}): Incoming => ({ type: "message", m: { from: "+15555550105", text: "@Ted hi", timestamp: 9, direct: false, group: { id: GID }, addressedToMe: true, fromName: "Eve", ...over } });

test("groups: a message goes through the shared steps to the group admission, which gets the transcript", async () => {
  const got: any[] = [];
  const { r, pipeline } = rig({ admitGroup: async (_c: unknown, m: unknown) => void got.push(m), transcript: async () => "bring the ball" });
  await pipeline.handleIncoming(group(GID), gmsg());
  assert.deepEqual(r.reads, [{ ts: 9, from: "+15555550105" }]); // a read receipt to the author, when addressed
  assert.deepEqual([got[0].groupId, got[0].text, got[0].isOwner, got[0].addressedToMe, got[0].author], [GID, "@Ted hi", false, true, "+15555550105"]);
  await pipeline.handleIncoming(group(GID), gmsg({ text: "", audio: { id: "a.aac", size: 3 }, addressedToMe: false, timestamp: 10 }));
  assert.equal(got[1].text, "🎙️ bring the ball");
  assert.equal(got[1].voice, true);
  assert.equal(r.reads.length, 1); // not addressed: no "seen" mark
  await pipeline.handleIncoming(group(GID), gmsg({ from: OWNER }));
  assert.equal(got[2].isOwner, true);
});

test("groups: unvouched groups get nothing, not even a transcription or a receipt", async () => {
  let heard = 0;
  const got: unknown[] = [];
  const { r, pipeline } = rig({ vouch: false, transcript: async () => (heard++, "x"), admitGroup: async (_c: unknown, m: unknown) => void got.push(m) });
  await pipeline.handleIncoming(group(GID), gmsg({ text: "", audio: { id: "a.aac", size: 3 } }));
  assert.deepEqual([heard, got.length, r.reads.length, r.sent.length], [0, 0, 0, 0]);
});

test("groups: someone who spoke to it and cannot be understood is told; otherwise it moves on", async () => {
  const bad = async () => { throw new Error("I couldn't hear any words in that voice message."); };
  const loud = rig({ transcript: bad });
  await loud.pipeline.handleIncoming(group(GID), gmsg({ text: "", audio: { id: "a.aac", size: 3 } }));
  assert.deepEqual(loud.r.sent.map((s) => [s.text, s.groupId]), [["I couldn't hear any words in that voice message.", GID]]);
  const quiet = rig({ transcript: bad });
  await quiet.pipeline.handleIncoming(group(GID), gmsg({ text: "", audio: { id: "a.aac", size: 3 }, addressedToMe: false }));
  assert.equal(quiet.r.sent.length, 0);
});

test("groups: reactions reach the admission with the text they were made on", async () => {
  const got: any[] = [];
  const { pipeline } = rig({ admitGroup: async (_c: unknown, m: unknown) => void got.push(m) });
  await pipeline.handleIncoming(group(GID), { type: "reaction", r: { from: "+15555550105", emoji: "🔥", targetTimestamp: 1, isRemove: false, direct: false, group: { id: GID }, fromName: "Eve" } });
  assert.deepEqual(got[0].reaction, { emoji: "🔥", on: "an older message" });
});

test("groups: replies, reactions, typing and voice are aimed at the group; a thread under the asker is kept", async () => {
  const { r, pipeline } = rig({ ready: true });
  const conv = group(GID);
  const t = { author: "+15555550105", timestamp: 9 };
  const quote = { text: "@Ted hi", author: t.author, timestamp: 9 };
  const spoke = await pipeline.enqueue(conv, () => pipeline.runTurn(conv, { run: async () => ({ text: "[[react: 😂]] Howdy!" }), target: t, threadUnder: quote, announce: true }));
  assert.equal(spoke.spoke, true);
  assert.deepEqual(r.sent.map((s) => [s.text, s.quote, s.groupId]), [["Howdy!", quote, GID]]); // addressed: always threaded
  assert.deepEqual(r.reacts, [{ emoji: "😂", target: t, groupId: GID }]);
  assert.deepEqual(r.typing, [{ stop: false, groupId: GID }, { stop: true, groupId: GID }]);
  assert.deepEqual(r.records.map((x) => [x.groupId, x.kind]), [[GID, "chat"]]);
  const voiced = rig({ ready: true });
  await voiced.pipeline.enqueue(conv, () => voiced.pipeline.runTurn(conv, { run: async () => ({ text: "[[voice]] Hi all" }), target: t, announce: true }));
  assert.deepEqual([voiced.r.spoken, voiced.r.sent[0]!.groupId, voiced.r.sent[0]!.attachments?.length], [["Hi all"], GID, 1]);
  assert.equal(voiced.r.records[0]!.groupId, GID);
});

test("groups: [[silent]] is quiet, and a failure is explained to someone waiting, at most once in a while", async () => {
  const conv = group("Z3JvdXAtbm90aWNl");
  const boom = async (): Promise<{ text: string }> => { throw new RateLimitError("limit"); };
  const { r, pipeline } = rig();
  const go = (run: () => Promise<{ text: string }>, announce = true) => pipeline.enqueue(conv, () => pipeline.runTurn(conv, { run, announce, threadUnder: { text: "x", author: "a", timestamp: 1 } }));
  await go(async () => ({ text: "[[silent]]" }));
  assert.equal(r.sent.length, 0);
  await go(boom, false);
  assert.equal(r.sent.length, 0);
  const first = await go(boom);
  await go(boom);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0]!.text, /usage limit/);
  assert.deepEqual([first.noticed, r.sent[0]!.groupId], [true, conv.groupId]);
  assert.doesNotMatch(r.sent[0]!.text, /claude auth/);
});

test("groups: turns of one group run one at a time, other groups are not held up", async () => {
  const { pipeline } = rig();
  const a = group("Z3JvdXAtYQ==");
  const order: string[] = [];
  const slow = pipeline.enqueue(a, async () => { await new Promise((res) => setTimeout(res, 20)); order.push("a1"); });
  const next = pipeline.enqueue(a, async () => void order.push("a2"));
  const other = pipeline.enqueue(group("Z3JvdXAtYg=="), async () => void order.push("b"));
  await Promise.all([slow, next, other]);
  assert.deepEqual(order, ["b", "a1", "a2"]);
});
