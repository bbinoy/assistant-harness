import { statSync } from "node:fs";
import { appendLine, dataPath, readText, writeText } from "./state.ts";
import { settings } from "./settings.ts";

// Every message the assistant sends on Signal, with its Signal timestamp: one append-only file.
// It answers three questions the chat session cannot: what does a reaction (which carries only a
// timestamp) refer to, what did the assistant tell the owner on its own (alerts, handled mail,
// radar, the brief), and what was said a week ago (searchable, like any log, with search_logs).
//
// The file is bounded by SIZE, not age. Past MESSAGE_LOG_MB the oldest messages are folded into
// ONE short summary line at the top ("20 more messages about ..."), written by a small model; the
// summary itself is rewritten each time, so the file never grows past the limit. The owner's own


export const FILE = "logs/messages.jsonl"; // the owner's chat; a group has its own log, same format (groupstore.ts)
const MAX_TEXT = 4000;
const KEEP_AFTER_COMPACTION = 0.7; // compact down to this share of the limit, so it does not run on every message

// What was said: the assistant's own messages (chat, notice, approval, draft, brief, other), the OWNER's messages
// (owner, including voice transcripts) and the owner's reactions (reaction: "👎 on: <the message>"), and what was
// said in a group is NOT in this log: each group has its own, in the same format (member: what a person wrote there).
//
// The log is also the gate's LEDGER (gate.ts): "action" is something done without posting (a wake-up that stayed
// silent) and "wake" is the chosen next look (the last one is the state). They are not conversation: everything
// that reads the log as conversation (chat context, dream, compaction summaries, recent lines, finding the message
// a reaction was on) skips them; only search_logs and the gate itself see them.
export type Kind = "chat" | "notice" | "approval" | "draft" | "brief" | "other" | "owner" | "reaction" | "member" | "action" | "wake";

const LEDGER_KINDS: ReadonlySet<Kind> = new Set<Kind>(["action", "wake"]);
const isLedger = (kind: Kind) => LEDGER_KINDS.has(kind);

export interface Sent {
  ts: number; // Signal timestamp of the message
  at: string;
  kind: Kind;
  text: string;
}

interface Summary {
  kind: "summary";
  at: string;
  from: string;
  to: string;
  count: number;
  text: string;
}

export type Summarize = (previous: Summary | undefined, old: readonly Sent[]) => Promise<string>;

const parse = (line: string): Sent | Summary | undefined => {
  try {
    const e = JSON.parse(line);
    return e && typeof e.text === "string" ? e : undefined;
  } catch {
    return undefined;
  }
};

const isSummary = (e: Sent | Summary): e is Summary => e.kind === "summary";

// Parsed logs are cached per file, keyed by what stat says (inode, size, mtime): any append, rewrite (compaction
// writes a new file) or deletion changes the key, so a hit is always what a fresh read would give. Bounded, because
// every group has a log: only the most recently used few are kept.
const MAX_CACHED_LOGS = 8;
const parsed = new Map<string, { sig: string; sent: Sent[]; summary?: Summary }>();

// What changes whenever the file does ("" when there is none). Cheap: one stat.
export function logSignature(file: string = FILE): string {
  try {
    const s = statSync(dataPath(file));
    return `${s.ino}:${s.size}:${s.mtimeMs}`;
  } catch {
    return "";
  }
}

function readAll(file: string = FILE): { sent: Sent[]; summary?: Summary } {
  const sig = logSignature(file);
  const hit = parsed.get(file);
  if (hit && sig && hit.sig === sig) {
    parsed.delete(file); // most recently used last
    parsed.set(file, hit);
    return hit;
  }
  const sent: Sent[] = [];
  let summary: Summary | undefined;
  for (const line of (readText(file) ?? "").split("\n")) {
    const e = line ? parse(line) : undefined;
    if (!e) continue;
    if (isSummary(e)) summary = e;
    else sent.push(e);
  }
  parsed.delete(file);
  if (sig) {
    parsed.set(file, { sig, sent, summary });
    while (parsed.size > MAX_CACHED_LOGS) parsed.delete(parsed.keys().next().value!);
  }
  return { sent, summary };
}

const compacting = new Set<string>(); // files being compacted: one run at a time per log

export function recordMessage(kind: Kind, ts: number, text: string, now = new Date(), file: string = FILE): void {
  if (!text.trim()) return;
  appendLine(file, JSON.stringify({ ts, at: now.toISOString(), kind, text: text.slice(0, MAX_TEXT) } satisfies Sent));
}

// The message a reaction was on, if it is still in the log.
export const findMessage = (ts: number, file: string = FILE): Sent | undefined => readAll(file).sent.find((m) => m.ts === ts && m.kind !== "reaction" && !isLedger(m.kind));

// Everything said after `sinceIso` (all of it when undefined), oldest first. Conversation only: no ledger lines.
export const messagesSince = (sinceIso?: string, file: string = FILE): Sent[] => readAll(file).sent.filter((m) => !isLedger(m.kind) && (!sinceIso || m.at > sinceIso));

// Every line including the ledger, oldest first: for the gate (gate.ts) alone.
export const ledgerEntries = (file: string = FILE): readonly Sent[] => readAll(file).sent; // shared with the cache: read-only

const NOTICE_KINDS = new Set<Kind>(["notice", "draft", "brief"]);
const NOTICE_AGE_MS = settings.noticeAgeHours * 3600_000;

// Pure: what the assistant told the owner on its own in the last day, as plain lines for a prompt,
// oldest first, the last few only. The chat reads it to understand "yes, do that"; the radar, to
// avoid saying the same thing twice.
export function noticeLines(sent: readonly Sent[], now: Date, keep = 8): string[] {
  return sent
    .filter((m) => NOTICE_KINDS.has(m.kind) && now.getTime() - Date.parse(m.at) < NOTICE_AGE_MS)
    .slice(-keep)
    .map((m) => `[${new Date(m.at).toTimeString().slice(0, 5)}] ${m.text.slice(0, 700).replace(/\s*\n\s*/g, " / ")}`);
}

export const recentNotices = (now = new Date()) => noticeLines(readAll().sent, now);

// Pure: which of the lines (oldest first, a summary first of all) must go to get under the limit.
// Returns how many leading lines to fold into the summary, or 0 when the file is small enough.
export function planCompaction(lines: readonly string[], maxBytes: number): number {
  const size = (l: string) => Buffer.byteLength(l) + 1;
  let total = lines.reduce((n, l) => n + size(l), 0);
  if (total <= maxBytes) return 0;
  const target = maxBytes * KEEP_AFTER_COMPACTION;
  let drop = 0;
  while (total > target && drop < lines.length - 1) total -= size(lines[drop++]!); // always keep the newest
  return drop;
}

// Pure: cap a model's summary to a number of words.
export function limitWords(text: string, words: number): string {
  const w = text.trim().split(/\s+/).filter(Boolean);
  return w.length <= words ? w.join(" ") : `${w.slice(0, words).join(" ")}…`;
}

// Fold the oldest messages into the summary when the file is over its limit. Safe to call often;
// one run at a time. Messages sent while the summary is being written are kept.
export async function compactIfNeeded(summarize: Summarize, maxBytes = settings.messageLogMb * 1_000_000, file: string = FILE): Promise<boolean> {
  if (compacting.has(file)) return false;
  try {
    if (statSync(dataPath(file)).size <= maxBytes) return false; // the common case: nothing to read
  } catch {
    return false;
  }
  const lines = (readText(file) ?? "").split("\n").filter(Boolean);
  const drop = planCompaction(lines, maxBytes);
  if (drop === 0) return false;
  compacting.add(file);
  try {
    const old = lines.slice(0, drop).map(parse).filter((e): e is Sent | Summary => !!e);
    const previous = old.find(isSummary);
    const folded = old.filter((e): e is Sent => !isSummary(e) && !isLedger(e.kind)); // ledger lines are not worth a word in the summary
    let text: string;
    try {
      text = limitWords(await summarize(previous, folded), settings.summaryWords);
    } catch (e) {
      console.error("messages: could not summarize, keeping a count only:", (e as Error).message);
      text = "older messages, no summary available";
    }
    const summary: Summary = {
      kind: "summary",
      at: new Date().toISOString(),
      from: previous?.from ?? folded[0]?.at ?? new Date().toISOString(),
      to: folded.at(-1)?.at ?? previous?.to ?? new Date().toISOString(),
      count: (previous?.count ?? 0) + folded.length,
      text,
    };
    // Re-read: anything appended during the summary comes after the lines we folded.
    const now = (readText(file) ?? "").split("\n").filter(Boolean);
    writeText(file, [JSON.stringify(summary), ...now.slice(drop)].join("\n") + "\n");
    return true;
  } finally {
    compacting.delete(file);
  }
}
