import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noteContent, type Scope } from "./dream.ts";
import { compactIfNeeded, messagesSince, recordMessage, type Kind, type Sent } from "./messages.ts";
import { matchLines } from "./logsearch.ts";
import { forgetNote, MAX_NOTE_CHARS, parseNote, readNotes, type Note } from "./notes.ts";
import { settings } from "./settings.ts";
import { readText } from "./state.ts";
import { summarizeWithHaiku } from "./summarize.ts";

// Everything a group has: its own notes (what members asked the assistant to remember there) and its own
// message history, in the same formats as the owner's, but in separate places that nothing private reads
// or writes. A group is told apart by a short hash of its id:
//   memory/groups/<key>/notes/    the group's notes, one fact per file
//   memory/groups/<key>/backup/   snapshots of those notes made by the group's dream
//   memory/groups/<key>/meta.json the group's id and name
//   logs/group-<key>.jsonl        everything written in the group and the assistant's replies, size-bounded
// The owner's chat can read all of it (read-only); nothing flows the other way.

export const GROUPS_DIR = join(settings.memoryDir, "groups");
export const GROUP_CATEGORIES = ["people", "context", "scheduling", "style"] as const;
export const GROUP_NOTE_CHARS = 600; // members write these: shorter than the owner's
export const GROUP_MAX_NOTES = 40;

export const groupKey = (groupId: string): string => createHash("sha256").update(groupId).digest("hex").slice(0, 12);
export const groupLogFile = (groupId: string): string => `logs/group-${groupKey(groupId)}.jsonl`;

// The group's folder (made on first use); the name is kept up to date in meta.json.
export function groupDir(groupId: string, name?: string): string {
  const dir = join(GROUPS_DIR, groupKey(groupId));
  mkdirSync(join(dir, "notes"), { recursive: true, mode: 0o700 });
  const meta = join(dir, "meta.json");
  const known = existsSync(meta) ? (JSON.parse(readFileSync(meta, "utf8")) as { name?: string }) : undefined;
  if (!known || (name && known.name !== name)) writeFileSync(meta, JSON.stringify({ id: groupId, name: name ?? known?.name ?? "" }), { mode: 0o600 });
  return dir;
}

export const groupScope = (groupId: string): Scope => {
  const dir = groupDir(groupId);
  return { notesDir: join(dir, "notes"), backupsDir: join(dir, "backup"), categories: GROUP_CATEGORIES, index: false, maxNotes: GROUP_MAX_NOTES };
};

export interface KnownGroup {
  id: string;
  name: string;
  dir: string;
}

export function listGroups(): KnownGroup[] {
  try {
    return readdirSync(GROUPS_DIR)
      .map((key) => ({ key, dir: join(GROUPS_DIR, key) }))
      .filter(({ dir }) => existsSync(join(dir, "meta.json")))
      .map(({ dir }) => ({ ...(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { id: string; name: string }), dir }));
  } catch {
    return [];
  }
}

// ---- history ----

// A line in the group's log. What members wrote is kind "member" (text starts with who wrote it); the
// assistant's own replies are kind "chat".
export function recordGroup(groupId: string, kind: Kind, ts: number, text: string): void {
  const file = groupLogFile(groupId);
  recordMessage(kind, ts, text, new Date(), file);
  void compactIfNeeded(summarizeWithHaiku, settings.groupLogMb * 1_000_000, file).catch((e) => console.error("group log: compaction failed:", (e as Error).message));
}

export const groupHistorySince = (groupId: string, sinceIso?: string): Sent[] => messagesSince(sinceIso, groupLogFile(groupId));

// The last few lines of context before a new message, oldest first.
export function recentGroupLines(groupId: string, n = 25): string[] {
  return groupHistorySince(groupId)
    .filter((m) => m.kind === "member" || m.kind === "chat")
    .slice(-n)
    .map((m) => `[${new Date(m.at).toTimeString().slice(0, 5)}] ${m.kind === "chat" ? `${settings.assistant}: ` : ""}${m.text.replace(/\n+/g, " / ").slice(0, 600)}`);
}

// Search the group's whole log (the oldest part is one summary line). Words must all appear.
export function searchGroupHistory(groupId: string, args: { query?: string; sinceHours?: number; limit?: number }): string {
  const hits = matchLines(readText(groupLogFile(groupId)) ?? "", { query: args.query, sinceHours: args.sinceHours });
  if (hits.length === 0) return "No matching messages.";
  const limit = Math.max(1, Math.min(60, Math.floor(args.limit ?? 25)));
  return `${hits.length > limit ? `Showing the last ${limit} of ${hits.length} matching lines.\n` : ""}${hits.slice(-limit).join("\n")}`;
}

// ---- notes ----

const NOTE_FILE = new RegExp(`^(${GROUP_CATEGORIES.join("|")})-[a-z0-9][a-z0-9-]{0,50}\\.md$`);

export const groupNotes = (groupId: string, now = new Date()): Note[] => readNotes(now, join(groupDir(groupId), "notes"));

// A member asked the assistant to remember something. Anyone in the group may, so this is bounded
// instead of trusted: the right shape of name, a short text, a limited number of notes.
export function saveGroupNote(groupId: string, n: { file: string; description: string; text: string; expires?: string }, now = new Date()): { ok: true; replaced: boolean } | { ok: false; error: string } {
  const text = n.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  const description = n.description.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!NOTE_FILE.test(n.file)) return { ok: false, error: `name the file <category>-<short-slug>.md, with a category of ${GROUP_CATEGORIES.join(", ")} (lower case, dashes)` };
  if (!text || !description) return { ok: false, error: "give a description and the text to remember" };
  if (text.length > Math.min(GROUP_NOTE_CHARS, MAX_NOTE_CHARS)) return { ok: false, error: `keep a note under ${GROUP_NOTE_CHARS} characters; split it or shorten it` };
  if (n.expires !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(n.expires)) return { ok: false, error: "expires must be a date, YYYY-MM-DD" };
  const dir = join(groupDir(groupId), "notes");
  const replaced = existsSync(join(dir, n.file));
  if (!replaced && readdirSync(dir).filter((f) => f.endsWith(".md")).length >= GROUP_MAX_NOTES) return { ok: false, error: "memory for this group is full: forget something first" };
  writeFileSync(join(dir, n.file), noteContent(n.file, description, text, n.expires, now), { mode: 0o600 });
  return { ok: true, replaced };
}

export const forgetGroupNote = (groupId: string, file: string) => forgetNote(file, join(groupDir(groupId), "notes"));

// Pure: the group's notes as fenced data for the group's prompt.
export function groupNotesBlock(notes: readonly Note[]): string {
  const lines = notes.map((n) => `- [${n.category}] ${n.file}: ${n.text.replace(/\s*\n\s*/g, " ").slice(0, GROUP_NOTE_CHARS)}${n.expires ? ` (until ${n.expires})` : ""}`);
  return lines.length ? lines.join("\n") : "";
}

export { parseNote };
