import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit } from "./audit.ts";
import { errorNotice, groupErrorNotice } from "./errors.ts";
import { GROUPS_DIR, groupKey, groupLogFile, groupNotesDir } from "./groupstore.ts";
import type { GroupMessage } from "./group.ts";
import { FILE as OWNER_LOG, findMessage, revisionsOf, type Extra, type Kind } from "./messages.ts";
import { DELETED_LINE, editNote, isAuthor, sameText } from "./edit.ts";
import { NOTES_DIR } from "./notes.ts";
import { MAX_PICTURES, PICTURE_NOTE, type Picture } from "./image.ts";
import { OWNER_SESSION_FILE } from "./session.ts";
import { shouldThread, withQuoteContext } from "./quote.ts";
import { reactionPrompt, splitReaction } from "./reaction.ts";
import { splitVoice, VOICE_FAILED_NOTE, voiceOption } from "./voicereply.ts";
import { settings } from "./settings.ts";
import { clean, LIMITS, oneLine } from "./sanitize.ts";
import { startTiming, type Timing } from "./timing.ts";
import type { IncomingDeletion, IncomingMessage, IncomingReaction, Quote } from "@ted-personal-assistant/signal";
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
  readonly vouch: boolean; // is the owner's membership checked before anything is read (groups: a stranger cannot add us to a group and use us)
  readonly attention: "always" | "addressed"; // who gets a read receipt and an explanation of an unusable voice message or picture: everyone (the owner's chat) or only someone who spoke to us
  readonly optionalPictures: boolean; // a picture is opened only when it will be used, and an unopenable one is dropped (the caption stays); otherwise it is required
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
  sessionFile: OWNER_SESSION_FILE,
  gate: false,
  approvals: true,
  vouch: false,
  attention: "always",
  optionalPictures: false,
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
    vouch: true,
    attention: "addressed",
    optionalPictures: true,
    threadAlways: true, // a group scrolls: say whom you answer
    noticeEveryMs: settings.groupNoticeMinutes * 60_000, // a failure is reported at most this often per group
    notice: groupErrorNotice, // nobody there should be sent to a terminal
  });

// A message with its picture, once prepared (the bytes are held for this turn only; src/image.ts).
type Held = IncomingMessage & { voice?: boolean; picture?: Picture; edit?: { before?: string } }; // voice: the text is a transcript of a voice message (set by hear); edit: an edit of a message that was answered already, with the version it replaces

export type Incoming = { type: "message"; m: IncomingMessage } | { type: "reaction"; r: IncomingReaction } | { type: "deletion"; d: IncomingDeletion };

// What one run needs. The caller (the owner's path here, the group brain in group.ts) builds it.
interface RunHooks {
  firstOutput: () => void; // the model produced its first message (timing only)
}

interface Turn {
  run: (hooks: RunHooks) => Promise<{ text: string; costUsd?: number }>;
  timing?: Timing; // the burst's timing, logged as one line when the turn ends (timing.ts)
  target?: { author: string; timestamp: number }; // the message to react to (and to show status icons on)
  threadUnder?: Quote; // what a threaded answer quotes
  hadQuote?: boolean; // the message was itself a reply: thread the answer
  announce: boolean; // somebody is waiting: a failure is explained to them
  reaction?: boolean; // the turn answers a reaction: no typing, no status icons, no apology
  background?: boolean; // nobody wrote: a wake-up (wake.ts). Like a reaction, no typing, icons or apology; the answer is still compacted after
  kind?: Kind; // how the reply is logged (default "chat"); the owner's wake-ups are "notice", which the chat is told about
}

interface TurnResult {
  spoke: boolean; // something was said (words or voice)
  error?: unknown;
  noticed?: boolean; // the failure was explained in the conversation
}

interface PipelineDeps {
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
  record: (groupId: string | undefined, kind: Kind, ts: number, text: string, extra?: Extra) => void; // into that conversation's log
  account: string; // our own Signal number: the author of messages of ours that a reaction points at
  runOwner: (prompt: string, ownerMessage: string, pictures?: Picture[], hooks?: RunHooks) => Promise<{ text: string; costUsd?: number }>;
  picture: (m: IncomingMessage) => Promise<Picture>; // throws a sentence the sender can be told
  transcript: (m: IncomingMessage) => Promise<string>; // throws a sentence the sender can be told
  speech: { ready: () => boolean; synth: (words: string) => Promise<string> }; // spoken replies: local TTS, a file
  approvals: { answer: (text: string, working: () => void, quote?: { timestamp: number }) => Promise<{ outcome: "none" | "approved" | "modified" | "declined" | "feedback" | "clarify"; changes?: { field: string; value: unknown }[]; reply?: string; note?: string }>; answerReaction: (emoji: string, ts: number) => string };
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group?
  isOwner: (who: { from: string; fromUuid?: string }) => boolean;
  admitGroup: (conv: Conversation, m: GroupMessage) => Promise<void>; // the participation gate (group.ts)
  compact?: (conv: Conversation, mode: "urgent") => Promise<void>; // after an answer is out, only if the conversation grew far past the limit; the next message waits for it. Every conversation (quiet-time compaction is the heartbeat's, wake.ts)
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
  timing: Timing; // this burst's timing; zero is the arrival of its newest message
  run: (job: (items: T[]) => Promise<void>) => Promise<void>;
}

const SILENT = /^\s*\[\[silent\]\]\s*$/i;

// A message as it comes in from Signal, cleaned: text (also a picture's caption), the sender's name and the quoted text.
export const cleanIncoming = (m: IncomingMessage): IncomingMessage => ({
  ...m,
  text: clean("message", m.text, { max: LIMITS.body }),
  ...(m.fromName ? { fromName: oneLine("group member name", m.fromName, LIMITS.name) } : {}),
  ...(m.quote ? { quote: { ...m.quote, text: clean("quoted message", m.quote.text, { max: LIMITS.line }) } } : {}),
});

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
  // `arrivedAt`: when the message really came in, if earlier than this call (voice transcription, group lookup).
  async function burst<T>(conv: Conversation, item: T, settled: (b: Batch<T>) => Promise<void>, arrivedAt: number = now()): Promise<void> {
    const timing = startTiming(conv.kind, now, arrivedAt);
    const st = bursts.get(conv.key) ?? { epoch: 0, pending: [], queued: false };
    bursts.set(conv.key, st);
    if (!st.pending.length) st.firstAt = now();
    st.pending.push(item);
    const mine = ++st.epoch;
    const maxMs = deps.settleMaxMs ? deps.settleMaxMs() : settings.settleMaxSeconds * 1000;
    const left = Math.max(0, maxMs - (now() - (st.firstAt ?? now())));
    await wait(Math.min(deps.settleMs ? deps.settleMs() : settings.settleSeconds * 1000, left));
    if (st.epoch !== mine || st.queued || !st.pending.length) return; // a newer message took over, or a queued run will take this one too
    timing.mark("settle");
    await settled({
      stale: () => st.epoch !== mine,
      timing,
      run: (job) => {
        st.queued = true;
        const queuedAt = now();
        return enqueue(conv, async () => {
          timing.set("queue", now() - queuedAt);
          st.queued = false;
          st.firstAt = undefined;
          const items = st.pending.splice(0) as T[];
          if (items.length) await job(items);
        });
      },
    });
  }

  // A run is already queued for the current burst, so a message arriving now joins it (no verdict of its own is needed).
  const burstQueued = (conv: Conversation): boolean => !!bursts.get(conv.key)?.queued;

  const record = (conv: Conversation, kind: Kind, ts: number, text: string, extra?: Extra) => deps.record(conv.groupId, kind, ts, text, extra);

  // Messages still waiting for their turn (the settling pause, or queued behind a running turn): an edit replaces one and a delete
  // removes one. Matched by timestamp: the original's or an edit's, whichever the sender's app uses.
  const stampOf = (x: unknown) => (x as { timestamp: number }).timestamp;
  const pendingOf = (conv: Conversation, stamps: readonly number[]) => bursts.get(conv.key)?.pending.find((x) => stamps.includes(stampOf(x)));
  const authorOf = (x: unknown) => (x as { author?: string; from?: string; fromUuid?: string }).author ?? (x as { from?: string }).from ?? (x as { fromUuid?: string }).fromUuid;
  function dropPending(conv: Conversation, stamps: readonly number[]): void {
    const st = bursts.get(conv.key);
    if (st) st.pending = st.pending.filter((x) => !stamps.includes(stampOf(x)));
  }

  // Timestamps of messages that were taken as the answer to an approval: an edit of one never answers anything (see edit()).
  const approvalAnswers = new Set<number>();
  const answeredApproval = (ts: number) => {
    approvalAnswers.add(ts);
    if (approvalAnswers.size > 200) approvalAnswers.delete(approvalAnswers.keys().next().value!);
  };

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

  // "typing…" for a conversation, from the moment it is decided to answer (not when the model starts) until the reply is out.
  // Holds are counted: the early one (the caller, while the gate's delay or an earlier turn is still running) and the turn's
  // own overlap without a stop and a restart in between; the last release stops it. Whoever holds must release (finally).
  // The one place that refreshes it (Signal clears it after a few seconds) and stops it, for the owner and every group.
  const typers = new Map<string, { holds: number; timer?: ReturnType<typeof setInterval> }>();
  function holdTyping(conv: Conversation, timing?: Timing): () => void {
    let t = typers.get(conv.key);
    if (!t) {
      // In an own-account chat Signal shows "typing…" (not in Note to Self, where the client ignores it).
      t = { holds: 0, timer: signal.separateAccount ? setInterval(() => void signal.typing(false, conv.groupId), 8000) : undefined };
      typers.set(conv.key, t);
      void signal.typing(false, conv.groupId);
    }
    timing?.mark("typing");
    const mine = t;
    mine.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--mine.holds > 0) return;
      clearInterval(mine.timer);
      typers.delete(conv.key);
      void signal.typing(true, conv.groupId);
    };
  }

  const lastNotice = new Map<string, number>();
  // Tell the conversation what went wrong (the usage limit, an expired login, "something broke"), at most once per conv.noticeEveryMs
  // (always in the owner's chat, every few minutes in a group). The one place both turns that fail and a gate that cannot decide use.
  async function warn(conv: Conversation, e: unknown, quote?: Quote): Promise<boolean> {
    if (now() - (lastNotice.get(conv.key) ?? 0) < conv.noticeEveryMs) return false;
    lastNotice.set(conv.key, now());
    return out.reply(conv.notice(e), { quote: conv.groupId ? quote : undefined, kind: conv.groupId ? "chat" : undefined, groupId: conv.groupId }).then(() => true, () => false);
  }

  // One run for one conversation: typing, the model, the reply, or a notice if it failed. Call it inside
  // enqueue(). It never throws: a failure becomes a notice (if someone is waiting) and a result.
  async function runTurn(conv: Conversation, turn: Turn): Promise<TurnResult> {
    const started = now();
    const background = !!turn.reaction || !!turn.background; // a reaction or a wake-up is no conversation: no typing, no icons
    if (!background) status(conv, "👀", turn.target); // 👀 working, ✅ answered, ⚠️ failed, each replacing the last
    const typing = background ? undefined : holdTyping(conv, turn.timing); // already showing if the decision to answer came earlier
    try {
      const { text, costUsd } = await turn.run({ firstOutput: () => turn.timing?.mark("first") });
      turn.timing?.set("run", now() - started);
      console.log(`${conv.kind} replied (${text.length} chars${costUsd === undefined ? "" : `, $${costUsd.toFixed(4)}`})`);
      const sent = await deliver(conv, text, { ...turn, started });
      turn.timing?.mark("total");
      turn.timing?.report(); // before compaction: that runs after the reply and is not part of the wait
      if (conv.kind === "group") audit("group_reply", sent.spoke || sent.reacted ? "sent" : "silent", "group");
      if (!turn.reaction) await deps.compact?.(conv, "urgent");
      return { spoke: sent.spoke };
    } catch (e) {
      turn.timing?.mark("total");
      turn.timing?.report();
      console.error(background ? `agent error (${turn.background ? "wake-up" : "reaction"}):` : `${conv.kind}: run failed:`, (e as Error).message); // a reaction needs no apology
      if (conv.kind === "group") audit("group_reply", "failed", "group", { error: (e as Error).message.slice(0, 200) });
      let noticed = false;
      if (!background) status(conv, "⚠️", turn.target);
      // Someone is waiting: say what is wrong (but not over and over, in a group).
      if (!background && turn.announce) noticed = await warn(conv, e, turn.threadUnder);
      return { spoke: false, error: e, noticed };
    } finally {
      typing?.();
      deps.afterTurn?.(conv);
    }
  }

  // The owner's messages of one burst, as the model sees them: oldest first, each with its own quote and voice marks.
  function ownerPrompt(ms: readonly Held[]): string {
    const one = (m: Held) => withQuoteContext(m.edit ? editNote(m.text, m.edit.before) : m.voice ? `[Voice message, transcribed automatically, so words may be misheard] ${m.text}` : m.picture ? `${PICTURE_NOTE} ${m.text}`.trim() : m.text, m.quote);
    const text = ms.length === 1 ? one(ms[0]!) : `${ms.length} messages arrived one after another, oldest first. Answer them together, as one reply:\n\n${ms.map(one).join("\n\n")}`;
    return canSpeak() ? `${text}\n\n${voiceOption(true)}` : text;
  }

  // Tell the sender why their voice message or picture could not be used: the owner always gets the reason (`before` runs
  // first, for the owner only); in a group only someone who spoke to the assistant does, otherwise it just moves on.
  async function tell(conv: Conversation, m: IncomingMessage, why: string, before?: () => void): Promise<void> {
    if (conv.attention === "always") {
      before?.();
      await out.replyPlain(why);
    } else if (m.addressedToMe) await out.reply(why, { kind: "chat", groupId: conv.groupId });
  }

  // Voice message -> text, or false when it could not be understood (the sender was told, if they should be).
  async function hear(conv: Conversation, m: IncomingMessage): Promise<Held | false> {
    const target = { author: m.from, timestamp: m.timestamp };
    if (conv.attention === "always") status(conv, "👂", target);
    try {
      return { ...m, text: clean("voice transcript", await deps.transcript(m), { max: LIMITS.body }), audio: undefined, voice: true };
    } catch (e) {
      await tell(conv, m, (e as Error).message, () => status(conv, "⚠️", target));
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
      await tell(conv, m, (e as Error).message);
      return false;
    }
  }

  // Everything a message goes through before its conversation decides what to do with it. The same steps for the owner and
  // every group; the Conversation's flags (vouch, attention, optionalPictures) say where they differ.
  async function intake(conv: Conversation, raw: IncomingMessage): Promise<void> {
    const original = cleanIncoming(raw); // the door: hidden characters never get past here
    const arrived = now();
    if (conv.vouch && !(await deps.vouch(conv.groupId!))) return; // a group we cannot vouch for gets nothing, not even a transcription
    if (original.edited) return edit(conv, original, arrived);
    const author = original.from || original.fromUuid;
    if (conv.attention === "always") void signal.markRead(original.timestamp); // the owner sees it was read, as soon as we have it
    else if (original.addressedToMe && author) void signal.markRead(original.timestamp, author); // only those who spoke to us see "seen"
    let m: Held = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = heard;
    }
    if (m.image) {
      // Looked at only when it will be used: in "tagged" mode a picture nobody addressed to us is just a line in the history.
      const seen = !conv.optionalPictures || m.addressedToMe || settings.groupParticipation !== "tagged" ? await see(conv, m) : false;
      if (!seen && !conv.optionalPictures) return;
      m = { ...m, image: undefined, picture: seen ? seen.picture : undefined };
    }
    // The line for the history: searchable, and what the dream learns from (never the picture itself).
    const line = original.audio ? `🎙️ ${m.text}` : original.image ? `🖼️ ${m.text || "image"}` : m.text;
    if (!conv.approvals) return deps.admitGroup(conv, { groupId: conv.groupId!, arrivedAt: arrived, text: line, picture: m.picture, timestamp: m.timestamp, isOwner: deps.isOwner(m), fromName: m.fromName, addressedToMe: !!m.addressedToMe, author, quote: m.quote, voice: m.voice });
    return ownerTurn(conv, m, line, arrived);
  }

  // An edit of an earlier message, the same for the owner's chat and every group. Only its author may edit it; the original may be
  //   still waiting (settling, queued, or being judged by the gate): the edit takes its place, so the answer is about the new text;
  //   answered already: the edit is a new message that says it is one (and what it replaced), so the answer can be corrected;
  //   unchanged (after whitespace and Unicode normalisation): nothing happens.
  // An edit is never an approval answer, whatever the original was: the owner's path below skips the approval check, and an edit of a
  // message that WAS taken as an answer is dropped altogether.
  async function edit(conv: Conversation, m: IncomingMessage, arrived: number): Promise<void> {
    const targetTs = m.edited!.targetTimestamp;
    const past = revisionsOf(targetTs, conv.logFile);
    const stamps = past ? past.stamps : [targetTs];
    if (stamps.some((t) => approvalAnswers.has(t))) return void console.log("edit of an approval answer ignored");
    const waiting = pendingOf(conv, stamps);
    if (!waiting && past && past.root.kind !== "owner" && past.root.kind !== "member" && past.root.kind !== "edit") return void console.log("edit of a message that is not someone's own ignored");
    if (!waiting && !past && conv.kind === "group") return void console.log("edit of an unknown message in a group ignored"); // nobody to check it against
    if (!isAuthor(m, waiting ? authorOf(waiting) : past?.root.by, conv.kind === "owner")) return void console.log(`edit by someone other than the author ignored (${conv.kind})`);
    const prior = waiting ? (waiting as { text: string }).text : past?.latest.text;
    const author = m.from || m.fromUuid;
    const via = { targetTimestamp: targetTs, stamps, prior, pending: !!waiting, picture: (waiting as { picture?: Picture } | undefined)?.picture };
    if (conv.kind === "group") {
      if (author && m.addressedToMe) void signal.markRead(m.timestamp, author);
      return deps.admitGroup(conv, { groupId: conv.groupId!, arrivedAt: arrived, text: m.text, picture: via.picture, timestamp: m.timestamp, isOwner: deps.isOwner(m), fromName: m.fromName, addressedToMe: !!m.addressedToMe, author, quote: m.quote, edit: via });
    }
    if (prior !== undefined && sameText(prior, m.text)) return void console.log("edit changes nothing, ignored");
    if (waiting) dropPending(conv, stamps);
    const held: Held = { ...m, picture: via.picture, ...(waiting ? {} : { edit: { before: prior } }) };
    return ownerTurn(conv, held, m.text, arrived, { of: targetTs });
  }

  async function ownerTurn(conv: Conversation, m: Held, line: string, arrived: number, edited?: { of: number }): Promise<void> {
    record(conv, edited ? "edit" : "owner", m.timestamp, line, { by: m.from || m.fromUuid, ...(edited ? { of: edited.of } : {}) });
    // While an approval is pending, a message may be its answer. That must skip the queue.
    // A spoken "yes" is never an approval, nor is a caption. Nor is an edit: an approval is answered by a new message, a reaction
    // or a quoted reply, so "no" edited into "yes" (or back) changes nothing.
    const target = { author: m.from, timestamp: m.timestamp };
    const { outcome, changes, reply, note } = edited || m.voice || m.picture ? { outcome: "none" as const, changes: undefined, reply: undefined, note: undefined } : await deps.approvals.answer(m.text, () => status(conv, "⏳", target), m.quote);
    if (outcome === "none" && note) await out.replyPlain(note).catch(() => {}); // soft styles: the judge failed; the approvals stay open and the message goes on as chat
    if (outcome !== "none") {
      answeredApproval(m.timestamp);
      console.log(`approval ${outcome}${changes ? ` (${changes.map((c) => c.field).join(", ")})` : ""}`);
      void signal.react({ approved: "👍", modified: "👍", declined: "👎", feedback: "💬", clarify: "💬" }[outcome], target, conv.groupId);
      // An edited call runs without a second look, so say exactly what changed.
      if (outcome === "clarify" && reply) await out.replyPlain(reply); // the approval stays open; this message was the answer to a question, not a request
      if (outcome === "modified" && changes) await out.replyPlain(`Applied your change: ${changes.map((c) => `${c.field} → ${c.value}`).join(", ")}`);
      return;
    }
    await burst(conv, m, async (b) => {
      const typing = holdTyping(conv, b.timing); // the owner is always answered: show it now, even while an earlier turn still runs
      try {
        await b.run(async (items) => {
          const ms = items.sort((a, c) => a.timestamp - c.timestamp);
          const last = ms[ms.length - 1]!;
          for (const x of ms) {
            console.log(`owner message (${x.text.length} chars)`);
            if (x.quote) console.log(`owner is replying to an earlier message (${x.quote.text.length} chars)`);
          }
          const prompt = ownerPrompt(ms);
          await runTurn(conv, {
            run: (hooks) => deps.runOwner(prompt, ms.map((x) => x.text).join("\n"), ms.flatMap((x) => x.picture ?? []).slice(-MAX_PICTURES), hooks),
            target: { author: last.from, timestamp: last.timestamp },
            threadUnder: { text: last.text.slice(0, 200), author: last.from, timestamp: last.timestamp },
            hadQuote: ms.some((x) => x.quote),
            announce: true,
            timing: b.timing,
          });
        });
      } finally {
        typing();
      }
    }, arrived);
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

  async function groupReaction(conv: Conversation, r: IncomingReaction): Promise<void> {
    const groupId = conv.groupId!;
    if (!(await deps.vouch(groupId))) return;
    const on = findMessage(r.targetTimestamp, conv.logFile)?.text ?? "an older message";
    return deps.admitGroup(conv, { groupId, text: "", timestamp: now(), isOwner: deps.isOwner(r), fromName: r.fromName && oneLine("group member name", r.fromName, LIMITS.name), addressedToMe: false, reaction: { emoji: oneLine("reaction", r.emoji, 16), on } });
  }

  // A message deleted for everyone. Only its author can. Still waiting: it is dropped, so it is never answered and nothing in it is
  // acted on. Answered already: a marker line says so, nothing runs again. Nobody is told about it, in a group least of all.
  async function deletion(conv: Conversation, d: IncomingDeletion): Promise<void> {
    if (conv.vouch && !(await deps.vouch(conv.groupId!))) return;
    const past = revisionsOf(d.targetTimestamp, conv.logFile);
    const stamps = past ? past.stamps : [d.targetTimestamp];
    const waiting = pendingOf(conv, stamps);
    if (!waiting && !past) return void console.log("delete of an unknown message ignored");
    if (past?.deleted) return;
    if (!waiting && past && past.root.kind !== "owner" && past.root.kind !== "member" && past.root.kind !== "edit") return void console.log("delete of a message that is not someone's own ignored");
    if (!isAuthor(d, waiting ? authorOf(waiting) : past?.root.by, conv.kind === "owner")) return void console.log(`delete by someone other than the author ignored (${conv.kind})`);
    dropPending(conv, stamps);
    console.log(`${conv.kind} message deleted by its author${waiting ? " before it was answered" : ""}`);
    if (conv.kind === "owner") return record(conv, "delete", now(), `[${DELETED_LINE}]`, { of: d.targetTimestamp });
    // The group brain writes the marker (it knows how members are named) and forgets a pending address of the deleted message.
    return deps.admitGroup(conv, { groupId: conv.groupId!, text: "", timestamp: now(), isOwner: deps.isOwner(d), fromName: d.fromName && oneLine("group member name", d.fromName, LIMITS.name), addressedToMe: false, deletion: { targetTimestamp: d.targetTimestamp, stamps } });
  }

  // Everything that arrives for a conversation. The caller has already decided who may speak to it
  // (guards.ts for the owner's chat; our own echoes and reactions are dropped before this).
  function handleIncoming(conv: Conversation, ev: Incoming): Promise<void> {
    if (ev.type === "deletion") return deletion(conv, ev.d);
    if (conv.kind === "owner") return ev.type === "message" ? intake(conv, ev.m) : ownerReaction(conv, ev.r);
    return ev.type === "message" ? intake(conv, ev.m) : groupReaction(conv, ev.r);
  }

  // A quick reaction of our own, no run needed (the gate chose it).
  const react = (conv: Conversation, emoji: string, target: { author: string; timestamp: number }) => void signal.react(emoji, target, conv.groupId);

  return { handleIncoming, enqueue, burst, burstQueued, wait, holdTyping, runTurn, deliver, record, canSpeak, react, warn, dropPending };
}

export type Pipeline = ReturnType<typeof createPipeline>;
