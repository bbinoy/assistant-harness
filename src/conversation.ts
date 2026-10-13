import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { audit } from "./audit.ts";
import { errorNotice, groupErrorNotice } from "./errors.ts";
import { GROUPS_DIR, groupKey, groupLogFile } from "./groupstore.ts";
import type { GroupMessage } from "./group.ts";
import { FILE as OWNER_LOG, findMessage, type Kind } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { shouldThread, withQuoteContext } from "./quote.ts";
import { reactionPrompt, splitReaction } from "./reaction.ts";
import { splitVoice, VOICE_INVITE } from "./voicereply.ts";
import { MAX_SPOKEN_CHARS, type IncomingMessage, type IncomingReaction, type Quote } from "@ted-personal-assistant/signal";

// The one pipeline every conversation goes through: the owner's private chat and each group. What differs
// between them is DATA on a Conversation, and a Conversation is made only by owner() and group(id), so trust
// cannot be mixed up by building one by hand. What is the same is the code: read receipt, voice message in,
// record, run, [[voice]] / [[react]] / [[silent]], quote threading, typing, error notice, one turn at a time.
//   owner   its own Signal chat; the full toolset (policy source "chat"); approvals exist; always answered
//   group   one Signal group; no private data (policy source "group"); the participation gate decides (group.ts)

export interface Conversation {
  readonly kind: "owner" | "group";
  readonly key: string; // queue key
  readonly groupId?: string; // the Signal target; unset: the owner's chat
  readonly source: "chat" | "group"; // policy source (src/policy.ts)
  readonly logFile: string; // this conversation's message log
  readonly notesDir: string; // this conversation's notes
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
    notesDir: join(GROUPS_DIR, groupKey(groupId), "notes"),
    gate: true,
    approvals: false,
    threadAlways: true, // a group scrolls: say whom you answer
    noticeEveryMs: 10 * 60_000, // a failure is reported at most this often per group
    notice: groupErrorNotice, // nobody there should be sent to a terminal
  });

export type Incoming = { type: "message"; m: IncomingMessage } | { type: "reaction"; r: IncomingReaction };

// What one run needs. The caller (the owner's path here, the group brain in group.ts) builds it.
export interface Turn {
  run: () => Promise<{ text: string; costUsd?: number }>;
  target?: { author: string; timestamp: number }; // the message to react to (and to show status icons on)
  threadUnder?: Quote; // what a threaded answer quotes
  hadQuote?: boolean; // the message was itself a reply: thread the answer
  announce: boolean; // somebody is waiting: a failure is explained to them
  reaction?: boolean; // the turn answers a reaction: no typing, no status icons, no apology
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
  runOwner: (prompt: string, ownerMessage: string) => Promise<{ text: string; costUsd?: number }>;
  transcript: (m: IncomingMessage) => Promise<string>; // throws a sentence the sender can be told
  speech: { ready: () => boolean; synth: (words: string) => Promise<string> }; // spoken replies: local TTS, a file
  approvals: { answer: (text: string, working: () => void) => Promise<{ outcome: "none" | "approved" | "modified" | "declined" | "feedback"; changes?: { field: string; value: unknown }[] }>; answerReaction: (emoji: string, ts: number) => string };
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group?
  isOwner: (who: { from: string; fromUuid?: string }) => boolean;
  admitGroup: (conv: Conversation, m: GroupMessage) => Promise<void>; // the participation gate (group.ts)
  compact?: (conv: Conversation) => Promise<void>; // after an answer is out; the next message waits for it
  afterTurn?: (conv: Conversation) => void; // e.g. warm up the process for the next message
  now?: () => number;
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
  async function deliver(conv: Conversation, replied: string, t: Pick<Turn, "target" | "threadUnder" | "hadQuote" | "reaction"> & { started: number }): Promise<{ spoke: boolean; reacted: boolean }> {
    const chosen = splitVoice(replied);
    let spoken = false;
    if (chosen.voice && canSpeak() && chosen.voice.length <= MAX_SPOKEN_CHARS) spoken = await speak(conv, chosen.voice);
    // The model may react instead of (or before) answering; its emoji then replaces the ✅ status.
    const { reaction, text } = splitReaction(spoken ? "" : chosen.text);
    const words = SILENT.test(text) ? "" : text;
    const quote = t.threadUnder && (conv.threadAlways || shouldThread(!!t.hadQuote, now() - t.started)) ? t.threadUnder : undefined;
    if (words) await out.reply(words, { kind: "chat", quote, groupId: conv.groupId });
    if (reaction && t.target) void signal.react(reaction, t.target, conv.groupId);
    else if (!t.reaction) status(conv, "✅", t.target);
    return { spoke: spoken || !!words, reacted: !!reaction };
  }

  const lastNotice = new Map<string, number>();

  // One run for one conversation: typing, the model, the reply, or a notice if it failed. Call it inside
  // enqueue(). It never throws: a failure becomes a notice (if someone is waiting) and a result.
  async function runTurn(conv: Conversation, turn: Turn): Promise<TurnResult> {
    const started = now();
    const background = !!turn.reaction; // a reaction is no conversation: no typing, no icons
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
      if (!background) await deps.compact?.(conv);
      return { spoke: sent.spoke };
    } catch (e) {
      console.error(background ? `agent error (reaction):` : `${conv.kind === "owner" ? "agent" : "group: run"} failed:`, (e as Error).message); // a reaction needs no apology
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

  // The owner's message, as the model sees it.
  function ownerPrompt(m: IncomingMessage): string {
    return withQuoteContext(m.voice ? `[Voice message, transcribed automatically, so words may be misheard${canSpeak() ? `; ${VOICE_INVITE}` : ""}] ${m.text}` : m.text, m.quote);
  }

  // Voice message -> text, or false when it could not be understood (the sender was told, if they should be).
  async function hear(conv: Conversation, m: IncomingMessage): Promise<IncomingMessage | false> {
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

  async function ownerMessage(conv: Conversation, original: IncomingMessage): Promise<void> {
    void signal.markRead(original.timestamp); // the owner sees it was read, as soon as we have it
    let m = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = heard;
    }
    record(conv, "owner", m.timestamp, m.voice ? `🎙️ ${m.text}` : m.text); // what the owner said: searchable, and what the dream learns from
    // While an approval is pending, a message may be its answer. That must skip the queue.
    // A spoken "yes" is never an approval.
    const target = { author: m.from, timestamp: m.timestamp };
    const { outcome, changes } = m.voice ? { outcome: "none" as const, changes: undefined } : await deps.approvals.answer(m.text, () => status(conv, "⏳", target));
    if (outcome !== "none") {
      console.log(`approval ${outcome}${changes ? ` (${changes.map((c) => c.field).join(", ")})` : ""}`);
      void signal.react({ approved: "👍", modified: "👍", declined: "👎", feedback: "💬" }[outcome], target, conv.groupId);
      // An edited call runs without a second look, so say exactly what changed.
      if (outcome === "modified" && changes) await out.replyPlain(`Applied your change: ${changes.map((c) => `${c.field} → ${c.value}`).join(", ")}`);
      return;
    }
    await enqueue(conv, () => {
      console.log(`owner message (${m.text.length} chars)`);
      if (m.quote) console.log(`owner is replying to an earlier message (${m.quote.text.length} chars)`);
      const prompt = ownerPrompt(m);
      return runTurn(conv, {
        run: () => deps.runOwner(prompt, m.text),
        target,
        threadUnder: { text: m.text.slice(0, 200), author: m.from, timestamp: m.timestamp },
        hadQuote: !!m.quote,
        announce: true,
      });
    });
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
    let m = original;
    if (m.audio) {
      const heard = await hear(conv, m);
      if (!heard) return;
      m = { ...heard, text: `🎙️ ${heard.text}` };
    }
    return deps.admitGroup(conv, { groupId, text: m.text, timestamp: m.timestamp, isOwner: deps.isOwner(m), fromName: m.fromName, addressedToMe: !!m.addressedToMe, author, quote: m.quote, voice: m.voice });
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

  return { handleIncoming, enqueue, runTurn, deliver, record, canSpeak };
}

export type Pipeline = ReturnType<typeof createPipeline>;
