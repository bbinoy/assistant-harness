import { join } from "node:path";
import { errorNotice, groupErrorNotice } from "./errors.ts";
import { GROUPS_DIR, groupKey, groupLogFile, groupNotesDir } from "./groupstore.ts";
import type { GroupMessage } from "./group.ts";
import { FILE as OWNER_LOG, type Extra, type Kind } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { type Picture } from "./image.ts";
import { OWNER_SESSION_FILE } from "./session.ts";
import type { TellSink } from "./telluser.ts";
import { settings } from "./settings.ts";
import { clean, LIMITS, oneLine } from "./sanitize.ts";
import { type Timing } from "./timing.ts";
import type { IncomingDeletion, IncomingMessage, IncomingReaction, Quote } from "@ted-personal-assistant/signal";

// The one pipeline every conversation goes through: the owner's private chat and each group. What differs

// What a conversation is (the owner's chat or a group: data, never built by hand) and the types the pipeline (conversation.ts) works with.

export interface Conversation {
  readonly kind: "owner" | "group";
  readonly key: string; // queue key
  readonly groupId?: string; // the Signal target; unset: the owner's chat
  readonly source: "chat" | "group"; // policy source (src/policy.ts)
  readonly logFile: string; // this conversation's message log
  readonly notesDir: string; // this conversation's notes (the SDK auto-memory folder; the only place its file tools may write)
  readonly sessionFile: string; // the resumed SDK session (session.ts): idle reset and compaction work on it
  readonly gate: boolean; // is the participation gate in front of it
  readonly approvals: boolean; // the owner's own turn path (an approval answer is read before the queue); groups read it in intake() before the gate, and any member's answer counts there
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
export type Held = IncomingMessage & { voice?: boolean; picture?: Picture; edit?: { before?: string } }; // voice: the text is a transcript of a voice message (set by hear); edit: an edit of a message that was answered already, with the version it replaces

export type Incoming = { type: "message"; m: IncomingMessage } | { type: "reaction"; r: IncomingReaction } | { type: "deletion"; d: IncomingDeletion };

// What one run needs. The caller (the owner's path here, the group brain in group.ts) builds it.
export interface RunHooks {
  firstOutput: () => void; // the model produced its first message (timing only)
  tell?: TellSink; // the model's tell_user tool (telluser.ts), for a conversation, not a reaction or a wake-up: sends an interim text message at once
}

export interface Turn {
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
    sendPicture(file: string, caption: string, opts?: { quote?: Quote; kind?: Kind; groupId?: string }): Promise<number>;
  };
  record: (groupId: string | undefined, kind: Kind, ts: number, text: string, extra?: Extra) => void; // into that conversation's log
  account: string; // our own Signal number: the author of messages of ours that a reaction points at
  runOwner: (prompt: string, ownerMessage: string, pictures?: Picture[], hooks?: RunHooks) => Promise<{ text: string; costUsd?: number }>;
  picture: (m: IncomingMessage) => Promise<Picture>; // throws a sentence the sender can be told
  transcript: (m: IncomingMessage) => Promise<string>; // throws a sentence the sender can be told
  speech: { ready: () => boolean; synth: (words: string) => Promise<string>; foreign: (words: string) => Promise<string | undefined> }; // spoken replies: local TTS, a file
  approvals: { answer: (text: string, working: () => void, quote?: { timestamp: number }, deps?: undefined, ctx?: { scope?: string; by?: string; voice?: boolean }) => Promise<{ outcome: "none" | "approved" | "modified" | "declined" | "feedback" | "clarify"; changes?: { field: string; value: unknown }[]; reply?: string }>; answerReaction: (emoji: string, ts: number, scope?: string, by?: string) => string };
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

// A message as it comes in from Signal, cleaned: text (also a picture's caption), the sender's name and the quoted text.
export const cleanIncoming = (m: IncomingMessage): IncomingMessage => ({
  ...m,
  text: clean("message", m.text, { max: LIMITS.body }),
  ...(m.fromName ? { fromName: oneLine("group member name", m.fromName, LIMITS.name) } : {}),
  ...(m.quote ? { quote: { ...m.quote, text: clean("quoted message", m.quote.text, { max: LIMITS.line }) } } : {}),
});
