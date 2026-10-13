import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit } from "./audit.ts";
import { errorNotice, groupErrorNotice } from "./errors.ts";
import { GROUPS_DIR, groupKey, groupLogFile, groupNotesDir } from "./groupstore.ts";
import type { GroupMessage } from "./group.ts";
import { FILE as OWNER_LOG, findMessage, type Kind } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { MAX_PICTURES, PICTURE_NOTE, type Picture } from "./image.ts";
import { shouldThread, withQuoteContext } from "./quote.ts";
import { reactionPrompt, splitReaction } from "./reaction.ts";
import { splitVoice, VOICE_FAILED_NOTE, voiceOption } from "./voicereply.ts";
import { settings } from "./settings.ts";
import type { IncomingMessage, IncomingReaction, Quote } from "@ted-personal-assistant/signal";
import { MAX_SPOKEN_CHARS } from "@ted-personal-assistant/signal/tts";

// The one pipeline every conversation goes through: the owner's private chat and each group. What differs
// between them is DATA on a Conversation, and a Conversation is made only by owner() and group(id), so trust
// cannot be mixed up by building one by hand. What is the same is the code: read receipt, voice message in,
// record, run, [[voice]] / [[react]] / [[silent]], quote threading, typing, error notice, one turn at a time.
// A burst of messages is one turn in both (burst below): a short settling pause, then everything that arrived is answered together.
//   owner   its own Signal chat; the full toolset (policy source "chat"); approvals exist; always answered
//   group   one Signal group; no private data (policy source "group"); the participation gate decides (group.ts)

export interface Conversation {
  readonly kind: "owner" | "group";
  readonly key: string; // queue key
  readonly groupId?: string; // the Signal target; unset: the owner's chat
  readonly source: "chat" | "group"; // policy source (src/policy.ts)
  readonly logFile: string; // this conversation's message log
  readonly notesDir: string; // this conversation's notes (the SDK auto-memory folder; the only place its file tools may write)
  readonly sessionFile: string; // the resumed SDK session (session.ts): idle reset and compaction work on it
  readonly gate: boolean; // is the participation gate in front of it
  readonly approvals: boolean; // can an approval be asked and answered here (the owner only)
  readonly threadAlways: boolean; // an answer to someone who addressed us is always threaded under it
  readonly noticeEveryMs: number; // at most one error notice per this long (0: always)
  readonly notice: (e: unknown) => string;
}

const OWNER_CONVERSATION: Conversation = Object.freeze({
  kind: "owner",
  key: "owner",
  source: "chat",
  logFile: OWNER_LOG,
  notesDir: NOTES_DIR,
  sessionFile: "state/session.json",
  gate: false,
  approvals: true,
  threadAlways: false,
  noticeEveryMs: 0,
  notice: errorNotice, // tells the owner where to look
});

export const owner = (): Conversation => OWNER_CONVERSATION;

// Not the group's folder itself: groupDir() creates it, and a Conversation is only data.
export const group = (groupId: string): Conversation =>
  Object.freeze({
    kind: "group",
    key: groupId,
    groupId,
    source: "group",
    logFile: groupLogFile(groupId),
    notesDir: groupNotesDir(groupId),
    sessionFile: join(GROUPS_DIR, groupKey(groupId), "session.json"),
    gate: true,
    approvals: false,
    threadAlways: true, // a group scrolls: say whom you answer
    noticeEveryMs: 10 * 60_000, // a failure is reported at most this often per group
    notice: groupErrorNotice, // nobody there should be sent to a terminal
  });

// A message with its picture, once prepared (the bytes are held for this turn only; src/image.ts).
type Held = IncomingMessage & { voice?: boolean; picture?: Picture }; // voice: the text is a transcript of a voice message (set by hear)

export type Incoming = { type: "message"; m: IncomingMessage } | { type: "reaction"; r: IncomingReaction };

// What one run needs. The caller (the owner's path here, the group brain in group.ts) builds it.
export interface Turn {
  run: () => Promise<{ text: string; costUsd?: number }>;
  target?: { author: string; timestamp: number }; // the message to react to (and to show status icons on)
  threadUnder?: Quote; // what a threaded answer quotes
  hadQuote?: boolean; // the message was itself a reply: thread the answer
  announce: boolean; // somebody is waiting: a failure is explained to them
  reaction?: boolean; // the turn answers a reaction: no typing, no status icons, no apology
  background?: boolean; // nobody wrote: a wake-up (wake.ts). Like a reaction, no typing, icons or apology; the answer is still compacted after
  kind?: Kind; // how the reply is logged (default "chat"); the owner's wake-ups are "notice", which the chat is told about
}

export interface TurnResult {
  spoke: boolean; // something was said (words or voice)
  error?: unknown;
  noticed?: boolean; // the failure was explained in the conversation
}

export interface PipelineDeps {
  signal: {
    separateAccount: boolean;
    react(emoji: string, target: { author: string; timestamp: number }, groupId?: string): Promise<void>;
    typing(stop?: boolean, groupId?: string): Promise<void>;
    markRead(timestamp: number, from?: string): Promise<void>;
  };
  out: {
    reply(text: string, opts?: { plain?: boolean; quote?: Quote; kind?: Kind; groupId?: string }): Promise<number>;
    replyPlain(text: string, kind?: Kind): Promise<number>;
    sendVoice(file: string, spoken: string, groupId?: string): Promise<number>;
  };
  record: (groupId: string | undefined, kind: Kind, ts: number, text: string) => void; // into that conversation's log
  account: string; // our own Signal number: the author of messages of ours that a reaction points at
  runOwner: (prompt: string, ownerMessage: string, pictures?: Picture[]) => Promise<{ text: string; costUsd?: number }>;
  picture: (m: IncomingMessage) => Promise<Picture>; // throws a sentence the sender can be told
  transcript: (m: IncomingMessage) => Promise<string>; // throws a sentence the sender can be told
  speech: { ready: () => boolean; synth: (words: string) => Promise<string> }; // spoken replies: local TTS, a file
  approvals: { answer: (text: string, working: () => void, quote?: { timestamp: number }) => Promise<{ outcome: "none" | "approved" | "modified" | "declined" | "feedback"; changes?: { field: string; value: unknown }[] }>; answerReaction: (emoji: string, ts: number) => string };
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group?
  isOwner: (who: { from: string; fromUuid?: string }) => boolean;
  admitGroup: (conv: Conversation, m: GroupMessage) => Promise<void>; // the participation gate (group.ts)
  compact?: (conv: Conversation) => Promise<void>; // after an answer is out; the next message waits for it. Every conversation
  afterTurn?: (conv: Conversation) => void; // after any turn, success or not (the owner: warm up the process for the next message)
  now?: () => number;
  wait?: (ms: number) => Promise<void>; // the settling pause (tests)
  settleMs?: () => number; // how long a burst must be quiet before it is answered (default: settings.settleSeconds)
  settleMaxMs?: () => number; // the longest a burst may wait since its first message, however long it keeps going (default: settings.settleMaxSeconds)
}

// What a settled burst hands its owner: whether a newer message has taken over, and the one queued run that takes every
// message gathered by the time the run starts (oldest first).
export interface Batch<T> {
  stale: () => boolean;
  run: (job: (items: T[]) => Promise<void>) => Promise<void>;
}

const SILENT = /^\s*\[\[silent\]\]\s*$/i;

export function createPipeline(deps: PipelineDeps) {
  const { signal, out } = deps;
  const now = deps.now ?? Date.now;

  // One turn at a time per conversation: two at once would share one session. Approval answers skip this
  // (see handleIncoming): the queue is blocked on the very turn that is waiting for them.
  const tails = new Map<string, Promise<unknown>>();
  function enqueue<T>(conv: Conversation, job: () => Promise<T>): Promise<T> {
    const run = (tails.get(conv.key) ?? Promise.resolve()).then(job);
    const tail = run.catch(() => {});
    tails.set(conv.key, tail);
    void tail.then(() => tails.get(conv.key) === tail && tails.delete(conv.key));
    return run;
  }

  // Burst handling, the same for every conversation: after each message wait a short settling pause; a newer message
  // restarts it and takes over, so a burst is ONE turn. Messages that arrive while that turn is queued join it; ones that
  // arrive while a run is in progress wait in the queue and make the next turn. Messages are kept here, in the order they came.
  // The pause is capped: once the first message of a burst has waited settleMaxSeconds, the burst is processed even if
  // people are still typing (what arrives after that joins the next turn).
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const wait = deps.wait ?? sleep;
  const bursts = new Map<string, { epoch: number; pending: unknown[]; queued: boolean; firstAt?: number }>();
  async function burst<T>(conv: Conversation, item: T, settled: (b: Batch<T>) => Promise<void>): Promise<void> {
    const st = bursts.get(conv.key) ?? { epoch: 0, pending: [], queued: false };
    bursts.set(conv.key, st);
    if (!st.pending.length) st.firstAt = now();
    st.pending.push(item);
    const mine = ++st.epoch;
    const maxMs = deps.settleMaxMs ? deps.settleMaxMs() : settings.settleMaxSeconds * 1000;
    const left = Math.max(0, maxMs - (now() - (st.firstAt ?? now())));
    await wait(Math.min(deps.settleMs ? deps.settleMs() : settings.settleSeconds * 1000, left));
    if (st.epoch !== mine || st.queued || !st.pending.length) return; // a newer message took over, or a queued run will take this one too
    await settled({
      stale: () => st.epoch !== mine,
      run: (job) => {
        st.queued = true;
        return enqueue(conv, async () => {
          st.queued = false;
          st.firstAt = undefined;
          const items = st.pending.splice(0) as T[];
          if (items.length) await job(items);
        });
      },
    });
  }

  const record = (conv: Conversation, kind: Kind, ts: number, text: string) => deps.record(conv.groupId, kind, ts, text);

  // Working / done / failed icons on the owner's message. Only in Note to Self, where Signal shows no
  // "typing…"; in an own-account chat the typing indicator says it, and groups are never decorated.
  const status = (conv: Conversation, emoji: string, target?: { author: string; timestamp: number }) => {
    if (target && !signal.separateAccount) void signal.react(emoji, target, conv.groupId);
  };

  const canSpeak = () => deps.speech.ready();

  // Speaks and sends. False on any failure: the caller then sends the words as text.
  async function speak(conv: Conversation, words: string): Promise<boolean> {
    let file: string | undefined;
    try {
      file = await deps.speech.synth(words);
      await out.sendVoice(file, words, conv.groupId);
      return true;
    } catch (e) {
      console.error("voice reply failed, sending text:", (e as Error).message);
      return false;
    } finally {
      if (file) rmSync(dirname(file), { recursive: true, force: true });
    }
  }

  // The reply of a run: by voice (only if speech is set up), a reaction, words, or nothing ([[silent]]).
  async function deliver(conv: Conversation, replied: string, t: Pick<Turn, "target" | "threadUnder" | "hadQuote" | "reaction" | "kind"> & { started: number }): Promise<{ spoke: boolean; reacted: boolean }> {
    const chosen = splitVoice(replied);
    let spoken = false;
    let speechFailed = false;
    if (chosen.voice && canSpeak() && chosen.voice.length <= MAX_SPOKEN_CHARS) speechFailed = !(spoken = await speak(conv, chosen.voice));
    // The model may react instead of (or before) answering; its emoji then replaces the ✅ status.
    const { reaction, text } = splitReaction(spoken ? "" : chosen.text);
    const said = SILENT.test(text) ? "" : text;
    const words = said && speechFailed ? `${said}\n\n${VOICE_FAILED_NOTE}` : said; // the model may have announced a voice message
    const quote = t.threadUnder && (conv.threadAlways || shouldThread(!!t.hadQuote, now() - t.started)) ? t.threadUnder : undefined;
    if (words) await out.reply(words, { kind: t.kind ?? "chat", quote, groupId: conv.groupId });
    if (reaction && t.target) void signal.react(reaction, t.target, conv.groupId);
    else if (!t.reaction) status(conv, "✅", t.target);
    return { spoke: spoken || !!words, reacted: !!reaction };
  }

  const lastNotice = new Map<string, number>();

  // One run for one conversation: typing, the model, the reply, or a notice if it failed. Call it inside
  // enqueue(). It never throws: a failure becomes a notice (if someone is waiting) and a result.
  async function runTurn(conv: Conversation, turn: Turn): Promise<TurnResult> {
    const started = now();
    const background = !!turn.reaction || !!turn.background; // a reaction or a wake-up is no conversation: no typing, no icons
    if (!background) {
      status(conv, "👀", turn.target); // 👀 working, ✅ answered, ⚠️ failed, each replacing the last
      // In an own-account chat Signal shows "typing…" (not in Note to Self); refreshed until the reply is out.
      void signal.typing(false, conv.groupId);
    }
    const typing = !background && signal.separateAccount ? setInterval(() => void signal.typing(false, conv.groupId), 8000) : undefined;
    try {
      const { text, costUsd } = await turn.run();
      console.log(`${conv.kind === "owner" ? "agent" : "group"} replied (${text.length} chars${costUsd === undefined ? "" : `, $${costUsd.toFixed(4)}`})`);
      const sent = await deliver(conv, text, { ...turn, started });
      if (conv.kind === "group") audit("group_reply", sent.spoke || sent.reacted ? "sent" : "silent", "group");
      if (!turn.reaction) await deps.compact?.(conv);
      return { spoke: sent.spoke };
    } catch (e) {
      console.error(background ? `agent error (${turn.background ? "wake-up" : "reaction"}):` : `${conv.kind === "owner" ? "agent" : "group: run"} failed:`, (e as Error).message); // a reaction needs no apology
      if (conv.kind === "group") audit("group_reply", "failed", "group", { error: (e as Error).message.slice(0, 200) });
      let noticed = false;
      if (!background) status(conv, "⚠️", turn.target);
      // Someone is waiting: say what is wrong (but not over and over, in a group).
      if (!background && turn.announce && now() - (lastNotice.get(conv.key) ?? 0) >= conv.noticeEveryMs) {
        lastNotice.set(conv.key, now());
        noticed = await out.reply(conv.notice(e), { quote: conv.groupId ? turn.threadUnder : undefined, kind: conv.groupId ? "chat" : undefined, groupId: conv.groupId }).then(() => true, () => false);
      }
      return { spoke: false, error: e, noticed };
    } finally {
      clearInterval(typing);
      if (!background) void signal.typing(true, conv.groupId);
      deps.afterTurn?.(conv);
    }
  }

  // The owner's messages of one burst, as the model sees them: oldest first, each with its own quote and voice marks.
  function ownerPrompt(ms: readonly Held[]): string {
    const one = (m: Held) => withQuoteContext(m.voice ? `[Voice message, transcribed automatically, so words may be misheard] ${m.text}` : m.picture ? `${PICTURE_NOTE} ${m.text}`.trim() : m.text, m.quote);
    const text = ms.length === 1 ? one(ms[0]!) : `${ms.length} messages arrived one after another, oldest first. Answer them together, as one reply:\n\n${ms.map(one).join("\n\n")}`;
    return canSpeak() ? `${text}\n\n${voiceOption(true)}` : text;
  }

  // Voice message -> text, or false when it could not be understood (the sender was told, if they should be).
  async function hear(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    const target = { author: m.from, timestamp: m.timestamp };
    if (conv.kind === "owner") status(conv, "👂", target);
    try {
      return { ...m, text: await deps.transcript(m), audio: undefined, voice: true };
    } catch (e) {
      // The owner always gets the reason; in a group only someone who spoke to it does, otherwise it just moves on.
      if (conv.kind === "owner") {
        status(conv, "⚠️", target);
        await out.replyPlain((e as Error).message);
      } else if (m.addressedToMe) {
        await out.reply((e as Error).message, { kind: "chat", groupId: conv.groupId });
      }
      return false;
    }
  }

  // A picture -> the message with it attached, or false when it could not be opened (the sender was told, if they should be).
  // The same step for every conversation; the bytes go to the model for this turn and nowhere else.
  async function see(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    console.log(`🖼️ image${m.text ? ` (caption ${m.text.length} chars)` : ""}`);
    try {
      return { ...m, image: undefined, picture: await deps.picture(m) };
    } catch (e) {
      if (conv.kind === "owner") await out.replyPlain((e as Error).message);
      else if (m.addressedToMe) await out.reply((e as Error).message, { kind: "chat", groupId: conv.groupId });
      return false;
    }
  }

  async function ownerMessage(conv: Conversation, original: IncomingMessage): Promise<void> {
    void signal.markRead(original.timestamp); // the owner sees it was read, as soon as we have it
    let m: Held = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = heard;
    }
    if (m.image) {
      const seen = await see(conv, m);
      if (!seen) return;
      m = seen;
    }
    record(conv, "owner", m.timestamp, m.voice ? `🎙️ ${m.text}` : m.picture ? `🖼️ ${m.text || "image"}` : m.text); // what the owner said: searchable, and what the dream learns from (never the picture itself)
    // While an approval is pending, a message may be its answer. That must skip the queue.
    // A spoken "yes" is never an approval, nor is a caption.
    const target = { author: m.from, timestamp: m.timestamp };
    const { outcome, changes } = m.voice || m.picture ? { outcome: "none" as const, changes: undefined } : await deps.approvals.answer(m.text, () => status(conv, "⏳", target), m.quote);
    if (outcome !== "none") {
      console.log(`approval ${outcome}${changes ? ` (${changes.map((c) => c.field).join(", ")})` : ""}`);
      void signal.react({ approved: "👍", modified: "👍", declined: "👎", feedback: "💬" }[outcome], target, conv.groupId);
      // An edited call runs without a second look, so say exactly what changed.
      if (outcome === "modified" && changes) await out.replyPlain(`Applied your change: ${changes.map((c) => `${c.field} → ${c.value}`).join(", ")}`);
      return;
    }
    await burst(conv, m, (b) =>
      b.run(async (items) => {
        const ms = items.sort((a, c) => a.timestamp - c.timestamp);
        const last = ms[ms.length - 1]!;
        for (const x of ms) {
          console.log(`owner message (${x.text.length} chars)`);
          if (x.quote) console.log(`owner is replying to an earlier message (${x.quote.text.length} chars)`);
        }
        const prompt = ownerPrompt(ms);
        await runTurn(conv, {
          run: () => deps.runOwner(prompt, ms.map((x) => x.text).join("\n"), ms.flatMap((x) => x.picture ?? []).slice(-MAX_PICTURES)),
          target: { author: last.from, timestamp: last.timestamp },
          threadUnder: { text: last.text.slice(0, 200), author: last.from, timestamp: last.timestamp },
          hadQuote: ms.some((x) => x.quote),
          announce: true,
        });
      }),
    );
  }

  // Any reaction that is not an approval answer is feedback on a message. The model is told which message
  // it was on (looked up by timestamp in the log) and decides what, if anything, it means.
  async function ownerReaction(conv: Conversation, r: IncomingReaction): Promise<void> {
    const outcome = deps.approvals.answerReaction(r.emoji, r.targetTimestamp);
    if (outcome !== "ignored") return void console.log(`approval ${outcome} (by reaction)`);
    await enqueue(conv, async () => {
      console.log(`owner reacted ${r.emoji}`);
      const on = findMessage(r.targetTimestamp, conv.logFile);
      record(conv, "reaction", now(), `${r.emoji} on: ${(on?.text ?? "an older message").slice(0, 200)}`);
      const prompt = reactionPrompt(r.emoji, on);
      await runTurn(conv, { run: () => deps.runOwner(prompt, prompt), target: { author: r.targetAuthor ?? deps.account, timestamp: r.targetTimestamp }, reaction: true, announce: false });
    });
  }

  // The shared steps for a group message, then the group's own question: should it speak (group.ts).
  async function groupMessage(conv: Conversation, original: IncomingMessage): Promise<void> {
    const groupId = conv.groupId!;
    if (!(await deps.vouch(groupId))) return; // a group we cannot vouch for gets nothing, not even a transcription
    const author = original.from || original.fromUuid;
    if (original.addressedToMe && author) void signal.markRead(original.timestamp, author); // only those who spoke to us see "seen"
    let m: Held = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = { ...heard, text: `🎙️ ${heard.text}` };
    }
    if (m.image) {
      // Looked at only when it will be used: in "tagged" mode a picture nobody addressed to us is just a line in the history.
      const seen = m.addressedToMe || settings.groupParticipation !== "tagged" ? await see(conv, m) : false;
      m = { ...m, image: undefined, picture: seen ? seen.picture : undefined, text: `🖼️ ${m.text || "image"}` };
    }
    return deps.admitGroup(conv, { groupId, text: m.text, picture: m.picture, timestamp: m.timestamp, isOwner: deps.isOwner(m), fromName: m.fromName, addressedToMe: !!m.addressedToMe, author, quote: m.quote, voice: m.voice });
  }

  async function groupReaction(conv: Conversation, r: IncomingReaction): Promise<void> {
    const groupId = conv.groupId!;
    if (!(await deps.vouch(groupId))) return;
    const on = findMessage(r.targetTimestamp, conv.logFile)?.text ?? "an older message";
    return deps.admitGroup(conv, { groupId, text: "", timestamp: now(), isOwner: deps.isOwner(r), fromName: r.fromName, addressedToMe: false, reaction: { emoji: r.emoji, on } });
  }

  // Everything that arrives for a conversation. The caller has already decided who may speak to it
  // (guards.ts for the owner's chat; our own echoes and reactions are dropped before this).
  function handleIncoming(conv: Conversation, ev: Incoming): Promise<void> {
    if (conv.kind === "owner") return ev.type === "message" ? ownerMessage(conv, ev.m) : ownerReaction(conv, ev.r);
    return ev.type === "message" ? groupMessage(conv, ev.m) : groupReaction(conv, ev.r);
  }

  // A quick reaction of our own, no run needed (the gate chose it).
  const react = (conv: Conversation, emoji: string, target: { author: string; timestamp: number }) => void signal.react(emoji, target, conv.groupId);

  return { handleIncoming, enqueue, burst, wait, runTurn, deliver, record, canSpeak, react };
}

export type Pipeline = ReturnType<typeof createPipeline>;
