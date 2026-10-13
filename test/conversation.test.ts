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

function rig(over: { separate?: boolean; run?: (prompt: string, own?: string) => Promise<string>; ready?: boolean; approval?: any; reactionApproval?: string; transcript?: (m: IncomingMessage) => Promise<string>; now?: () => number; vouch?: boolean; synth?: (words: string) => Promise<string>; admitGroup?: any } = {}) {
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
    approvals: { answer: async () => over.approval ?? { outcome: "none" }, answerReaction: () => over.reactionApproval ?? "ignored" },
    vouch: async () => over.vouch ?? true,
    isOwner: (w) => w.from === OWNER,
    admitGroup: over.admitGroup ?? (async () => {}),
    now: over.now,
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
  assert.match(seen.r.prompts[0]!, /^\[Voice message, transcribed automatically, so words may be misheard; you may answer by voice.*\] what is on today$/);
  assert.deepEqual(seen.r.spoken, ["Two meetings today."]);
  assert.equal(seen.r.sent.length, 1);
  assert.deepEqual([seen.r.sent[0]!.text, seen.r.sent[0]!.attachments?.length, seen.r.sent[0]!.groupId], ["", 1, undefined]);
  assert.deepEqual(seen.r.records.map((x) => x.text), ["🎙️ what is on today", "🔊 Two meetings today."]);
  assert.deepEqual(seen.r.reads, [{ ts: 111, from: undefined }]);
});

test("private chat: voice falls back to text when speech is off, too long, or fails; no invitation without speech", async () => {
  const off = rig({ ready: false, run: async () => "[[voice]] Hello there" });
  await off.pipeline.handleIncoming(owner(), msg({ text: "", audio: { id: "a.aac", size: 10 } }));
  assert.doesNotMatch(off.r.prompts[0]!, /answer by voice/);
  assert.deepEqual(off.r.sent.map((s) => s.text), ["Hello there"]);
  const long = rig({ ready: true, run: async () => `[[voice]] ${"word ".repeat(200)}` });
  await long.pipeline.handleIncoming(owner(), msg());
  assert.equal(long.r.spoken.length, 0);
  assert.equal(long.r.sent.length, 1);
  const broken = rig({ ready: true, synth: async () => { throw new Error("no tts"); }, run: async () => "[[voice]] Hello there" });
  await broken.pipeline.handleIncoming(owner(), msg());
  assert.deepEqual(broken.r.sent.map((s) => s.text), ["Hello there"]);
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

test("private chat: messages are answered one at a time, in order", async () => {
  let running = 0;
  let peak = 0;
  const order: string[] = [];
  const { pipeline } = rig({ run: async (p) => { peak = Math.max(peak, ++running); await new Promise((res) => setTimeout(res, 15)); order.push(p); running--; return "ok"; } });
  await Promise.all([pipeline.handleIncoming(owner(), msg({ text: "one" })), pipeline.handleIncoming(owner(), msg({ text: "two", timestamp: 112 }))]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["one", "two"]);
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
