import { readText, writeText, appendLine } from "./state.ts";
import { settings } from "./settings.ts";

// Every message the assistant sends on Signal, with its Signal timestamp: one append-only file.
// It answers three questions the chat session cannot: what does a reaction (which carries only a
// timestamp) refer to, what did the assistant tell the owner on its own (alerts, handled mail,
// radar, the brief), and what was said a week ago (searchable, like any log, with search_logs).
//
// The file is bounded by SIZE, not age. Past MESSAGE_LOG_MB the oldest messages are folded into
// ONE short summary line at the top ("20 more messages about ..."), written by a small model; the
// summary itself is rewritten each time, so the file never grows past the limit. The owner's own
// messages are not logged: the chat session already holds them.

const FILE = "logs/messages.jsonl";
const MAX_TEXT = 4000;
const KEEP_AFTER_COMPACTION = 0.7; // compact down to this share of the limit, so it does not run on every message

export type Kind = "chat" | "notice" | "approval" | "draft" | "brief" | "other";

export interface Sent {
  ts: number; // Signal timestamp of the message
  at: string;
  kind: Kind;
  text: string;
}

export interface Summary {
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

function readAll(): { sent: Sent[]; summary?: Summary } {
  const sent: Sent[] = [];
  let summary: Summary | undefined;
  for (const line of (readText(FILE) ?? "").split("\n")) {
    const e = line ? parse(line) : undefined;
    if (!e) continue;
    if (isSummary(e)) summary = e;
    else sent.push(e);
  }
  return { sent, summary };
}

let compacting = false;

export function recordMessage(kind: Kind, ts: number, text: string, now = new Date()): void {
  if (!text.trim()) return;
  appendLine(FILE, JSON.stringify({ ts, at: now.toISOString(), kind, text: text.slice(0, MAX_TEXT) } satisfies Sent));
}

// The message a reaction was on, if it is still in the log.
export const findMessage = (ts: number): Sent | undefined => readAll().sent.find((m) => m.ts === ts);

const NOTICE_KINDS = new Set<Kind>(["notice", "draft", "brief"]);
const NOTICE_AGE_MS = 24 * 3600_000;

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
export async function compactIfNeeded(summarize: Summarize, maxBytes = settings.messageLogMb * 1_000_000): Promise<boolean> {
  if (compacting) return false;
  const lines = (readText(FILE) ?? "").split("\n").filter(Boolean);
  const drop = planCompaction(lines, maxBytes);
  if (drop === 0) return false;
  compacting = true;
  try {
    const old = lines.slice(0, drop).map(parse).filter((e): e is Sent | Summary => !!e);
    const previous = old.find(isSummary);
    const folded = old.filter((e): e is Sent => !isSummary(e));
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
    const now = (readText(FILE) ?? "").split("\n").filter(Boolean);
    writeText(FILE, [JSON.stringify(summary), ...now.slice(drop)].join("\n") + "\n");
    return true;
  } finally {
    compacting = false;
  }
}
