import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { audit } from "./audit.ts";
import { clockLine } from "./brief.ts";
import { overBudget, recordCost } from "./budget.ts";
import { fence } from "./fence.ts";
import { messagesSince, type Sent } from "./messages.ts";
import { forgetNote, NOTES_DIR, MAX_NOTE_CHARS, parseNote, type Category } from "./notes.ts";
import { isPaused, localDay } from "./pause.ts";
import { dreamSystem } from "./persona.ts";
import { OWNER, settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

// The dream: once a day, before the daily brief, a model with NO tools reads what the owner said
// since the last dream (their messages and reactions) next to the current notes, and proposes
// changes to the notes as JSON: things worth remembering, and a tidy-up (merge duplicates,
// drop what has expired). It cannot touch anything itself. Code decides what is applied:
//   - a new fact needs a verbatim quote from the owner's own words that day (checked here);
//   - a merge may only shorten what it merges; an expired note is checked against its date;
//   - setup and voice notes are not the dream's to change;
//   - a cap on changes per run, and a snapshot first so "undo the dream" puts everything back.
// Everything it did is announced on the phone. Nothing it reads is mail: the owner's messages
// are the only ground for a note, so a crafted email cannot plant a memory.

const STATE = "state/dream.json";
const BACKUPS = join(settings.stateDir, "notes-backup");
const KEEP_SNAPSHOTS = 7;
const MAX_OPS = 16;
const MAX_WRITES = 8;
const MAX_DELETES = 12;
const MIN_EVIDENCE = 12; // characters of the owner's own words a new fact must quote
const MAX_PROMPT_NOTES_CHARS = 80_000;
const MAX_PROMPT_CONVERSATION_CHARS = 40_000;

// What the dream may write or delete. setup-* notes are the setup skill's (calendar ids, Notion
// pages) and voice-* notes come from the owner's sent mail: neither is learned from chat.
export const DREAM_CATEGORIES: readonly Category[] = ["triage", "people", "scheduling", "context", "brief", "style"];

export interface Op {
  op: "write" | "delete";
  file: string;
  description?: string;
  text?: string;
  expires?: string;
  evidence?: string; // a verbatim quote of the owner's own words
  consolidates?: string[]; // existing notes this one replaces (a merge or a rewrite)
  reason?: string;
}

export type Action =
  | { kind: "add" | "update" | "merge"; file: string; description: string; content: string; merged: string[] }
  | { kind: "delete"; file: string; why: string };

export interface Plan {
  actions: Action[];
  rejected: { file: string; why: string }[];
}

export interface NoteFile {
  file: string;
  raw: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const FILE = /^[a-z0-9][a-z0-9-]{0,70}\.md$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Pure: the note file the dream writes (same shape the chat's notes have).
export function noteContent(file: string, description: string, text: string, expires: string | undefined, now: Date): string {
  const name = file.replace(/\.md$/, "");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${expires ? `expires: ${expires}\n` : ""}metadata:\n  node_type: memory\n  type: user\n  origin: dream\n  modified: ${now.toISOString()}\n---\n\n${text}\n`;
}

// Pure: which of the model's proposals may be applied. Never trusts shape or content.
export function planOps(raw: unknown, ctx: { ownerText: string; notes: readonly NoteFile[]; today: string; now: Date; maxNotes?: number }): Plan {
  const plan: Plan = { actions: [], rejected: [] };
  const list = (raw as { ops?: unknown } | null | undefined)?.ops;
  if (!Array.isArray(list)) return plan;
  const owner = norm(ctx.ownerText);
  const existing = new Map(ctx.notes.map((n) => [n.file, parseNote(n.file, n.raw)]));
  const gone = new Set<string>(); // files an earlier action in this plan removes
  const deleted: string[] = [];
  let writes = 0;
  let count = existing.size;
  const reject = (file: string, why: string) => plan.rejected.push({ file, why });
  const quoted = (e: unknown) => typeof e === "string" && norm(e).length >= MIN_EVIDENCE && owner.includes(norm(e));
  const writable = (file: string) => DREAM_CATEGORIES.some((c) => file.startsWith(`${c}-`));

  for (const o of list.slice(0, MAX_OPS) as Op[]) {
    const file = typeof o?.file === "string" ? o.file : "";
    if (!FILE.test(file) || !writable(file)) { reject(file, "not a note the dream may change"); continue; }

    if (o.op === "delete") {
      const note = existing.get(file);
      if (!existsSync(join(NOTES_DIR, file)) || gone.has(file)) { reject(file, "no such note"); continue; }
      const expired = !!note?.expires && note.expires < ctx.today;
      if (!expired && !quoted(o.evidence)) { reject(file, "not expired, and no quote from the owner"); continue; }
      if (deleted.length >= MAX_DELETES) { reject(file, "too many deletions"); continue; }
      gone.add(file);
      deleted.push(file);
      plan.actions.push({ kind: "delete", file, why: expired ? "expired" : "the owner said so" });
      count--;
      continue;
    }

    if (o.op !== "write") { reject(file, "unknown operation"); continue; }
    const text = typeof o.text === "string" ? o.text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim() : "";
    const description = typeof o.description === "string" ? o.description.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!text || text.length > MAX_NOTE_CHARS || !description) { reject(file, "empty, or longer than a note may be"); continue; }
    if (o.expires !== undefined && !(typeof o.expires === "string" && DATE.test(o.expires) && o.expires >= ctx.today)) { reject(file, "bad expiry date"); continue; }
    if (writes >= MAX_WRITES) { reject(file, "too many changes in one run"); continue; }

    const sources = [...new Set(Array.isArray(o.consolidates) ? o.consolidates.filter((s): s is string => typeof s === "string") : [])];
    let kind: "add" | "update" | "merge";
    if (sources.length > 0) {
      // A merge may only shorten: it can carry no new information, so it needs no quote.
      if (!sources.every((s) => writable(s) && existing.get(s) && !gone.has(s))) { reject(file, "merge of a note that does not exist or is not the dream's"); continue; }
      const total = sources.reduce((n, s) => n + (existing.get(s)?.text.length ?? 0), 0);
      if (text.length > total) { reject(file, "a merge must not be longer than what it merges"); continue; }
      kind = "merge";
    } else {
      if (!quoted(o.evidence)) { reject(file, "no verbatim quote from the owner's own words"); continue; }
      kind = existing.has(file) ? "update" : "add";
    }
    if (kind === "add" && count >= (ctx.maxNotes ?? settings.memoryMaxNotes)) { reject(file, "memory is full"); continue; }
    writes++;
    if (kind === "add") count++;
    plan.actions.push({ kind, file, description, content: noteContent(file, description, text, o.expires, ctx.now), merged: sources });
    for (const s of sources) {
      if (s !== file && !gone.has(s)) {
        gone.add(s);
        plan.actions.push({ kind: "delete", file: s, why: `merged into ${file}` });
        count--;
      }
    }
  }
  return plan;
}

// ---- snapshots, applying, undoing ----

const stamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

function snapshot(now: Date): string {
  mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  const dir = join(BACKUPS, stamp(now));
  cpSync(NOTES_DIR, dir, { recursive: true });
  for (const old of readdirSync(BACKUPS).sort().slice(0, -KEEP_SNAPSHOTS)) rmSync(join(BACKUPS, old), { recursive: true, force: true });
  return dir;
}

function upsertIndex(file: string, description: string): void {
  const path = join(NOTES_DIR, "MEMORY.md");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l && !l.includes(`(${file})`)) : [];
  const title = file.replace(/\.md$/, "").replace(/^[a-z]+-/, "").replace(/-/g, " ");
  lines.push(`- [${title.charAt(0).toUpperCase()}${title.slice(1)}](${file}) - ${description}`);
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

// Applies a plan, after a snapshot. Returns the snapshot's folder (undefined if nothing to do).
export function applyPlan(plan: Plan, now = new Date()): string | undefined {
  if (plan.actions.length === 0) return undefined;
  const dir = snapshot(now);
  for (const a of plan.actions) {
    if (a.kind === "delete") forgetNote(a.file);
    else {
      writeFileSync(join(NOTES_DIR, a.file), a.content, { mode: 0o600 });
      upsertIndex(a.file, a.description);
    }
  }
  return dir;
}

// Puts the notes back as they were before the latest dream. The snapshot is used up.
export function undoLatest(): { ok: true; restored: number; from: string } | { ok: false; error: string } {
  const snaps = existsSync(BACKUPS) ? readdirSync(BACKUPS).sort() : [];
  const latest = snaps.at(-1);
  if (!latest) return { ok: false, error: "there is no dream to undo" };
  const dir = join(BACKUPS, latest);
  for (const f of readdirSync(NOTES_DIR)) if (f.endsWith(".md")) rmSync(join(NOTES_DIR, f));
  let restored = 0;
  for (const f of readdirSync(dir)) {
    cpSync(join(dir, f), join(NOTES_DIR, f));
    if (f !== "MEMORY.md") restored++;
  }
  rmSync(dir, { recursive: true, force: true });
  audit("dream_undo", "restored", "chat", { restored });
  return { ok: true, restored, from: latest };
}

// ---- what the model sees ----

const hhmm = (iso: string) => `${iso.slice(5, 10)} ${new Date(iso).toTimeString().slice(0, 5)}`;

// Pure: the conversation since the last dream as lines. Only the owner's own typed or spoken words
// can ground a note (ownerText). Their reactions are shown as signals, but the message they were on may
// quote mail, and the assistant's replies only make sense of "yes, do that": neither is evidence.
export function conversationLines(messages: readonly Sent[]): { lines: string[]; ownerText: string } {
  const lines: string[] = [];
  const owner: string[] = [];
  for (const m of messages) {
    if (m.kind === "owner") { lines.push(`[${hhmm(m.at)}] ${OWNER}: ${m.text.replace(/\n+/g, " / ")}`); owner.push(m.text); }
    else if (m.kind === "reaction") { lines.push(`[${hhmm(m.at)}] ${OWNER} reacted ${m.text.replace(/\n+/g, " / ")}`); } // shows what was reacted to, which may quote mail: never evidence
    else if (m.kind === "group") lines.push(`[${hhmm(m.at)}] group chat (context only): ${m.text.slice(0, 300).replace(/\n+/g, " / ")}`);
    else if (m.kind === "chat") lines.push(`[${hhmm(m.at)}] assistant (context only): ${m.text.slice(0, 300).replace(/\n+/g, " / ")}`);
  }
  return { lines, ownerText: owner.join("\n") };
}

export function dreamPrompt(now: Date, notes: readonly NoteFile[], messages: readonly Sent[]): string {
  const conv = conversationLines(messages).lines.join("\n");
  const cut = conv.length > MAX_PROMPT_CONVERSATION_CHARS ? conv.slice(-MAX_PROMPT_CONVERSATION_CHARS) : conv;
  const current = notes.map((n) => `### ${n.file}\n${n.raw.trim()}`).join("\n\n").slice(0, MAX_PROMPT_NOTES_CHARS);
  return [
    clockLine(now),
    `The notes you keep about ${OWNER} right now (one file per fact; MEMORY.md is the index and is updated for you):\n${fence("current_notes", current || "(none yet)")}`,
    `What ${OWNER} said and did since the last dream, oldest first:\n${fence("conversation", cut || "(nothing)")}`,
    `Propose the changes to the notes, if any.`,
  ].join("\n\n");
}

const SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ops"],
    properties: {
      ops: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "file"],
          properties: {
            op: { type: "string", enum: ["write", "delete"] },
            file: { type: "string" },
            description: { type: "string" },
            text: { type: "string" },
            expires: { type: "string" },
            evidence: { type: "string" },
            consolidates: { type: "array", items: { type: "string" } },
            reason: { type: "string" },
          },
        },
      },
    },
  },
};

const OPTIONS = (): Options => ({
  model: settings.model,
  systemPrompt: dreamSystem(),
  tools: [], // nothing to call: it answers with JSON and code applies what is allowed
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  settings: { autoMemoryEnabled: false },
  maxTurns: 3,
  maxBudgetUsd: 0.6,
  outputFormat: SCHEMA,
});

type Runner = (prompt: string) => Promise<unknown>;

const realRunner: Runner = async (prompt) => {
  for await (const m of query({ prompt, options: OPTIONS() })) {
    if (m.type !== "result") continue;
    recordCost(m.total_cost_usd);
    if (m.subtype !== "success" || m.is_error) throw new Error("the dream run failed");
    return m.structured_output;
  }
  throw new Error("no result");
};

// ---- the daily run ----

interface DreamState {
  day?: string; // local day of the last attempt
  lastRunAt?: string; // when the last real run started: what it covered ends here
}

export const readNoteFiles = (): NoteFile[] => {
  try {
    return readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort().map((file) => ({ file, raw: readFileSync(join(NOTES_DIR, file), "utf8") }));
  } catch {
    return [];
  }
};

export const dreamAnnouncement = (plan: Plan): string => {
  const icon = { add: "➕ saved", update: "✏️ updated", merge: "🔀 merged into" } as const;
  const lines = plan.actions.map((a) => (a.kind === "delete" ? `➖ forgot ${a.file} (${a.why})` : `${icon[a.kind]} ${a.file}: ${a.description}`));
  return `🌙 While you slept I tidied my memory:\n${lines.join("\n")}\n\nSay "undo the dream" and I'll put it back.`;
};

export function createDreamer(deps: { notify: (text: string) => Promise<void>; run?: Runner }) {
  let inFlight: Promise<void> | undefined;
  const runner = deps.run ?? realRunner;

  async function once(now: Date): Promise<void> {
    const today = localDay(now);
    const state = readJson<DreamState>(STATE, {});
    if (state.day === today) return;
    if (!settings.dream || isPaused(now) || overBudget().over) return;
    writeJson(STATE, { ...state, day: today }); // before the run: a crash must not mean a retry on every tick
    const messages = messagesSince(state.lastRunAt);
    const { ownerText } = conversationLines(messages);
    if (!messages.some((m) => m.kind === "owner")) {
      audit("dream_run", "nothing-new", "dream");
      return;
    }
    try {
      const notes = readNoteFiles();
      const raw = await runner(dreamPrompt(now, notes, messages));
      const plan = planOps(raw, { ownerText, notes, today, now });
      writeJson(STATE, { day: today, lastRunAt: now.toISOString() });
      const snap = applyPlan(plan, now);
      for (const r of plan.rejected) console.log(`dream: rejected ${r.file || "(no file)"}: ${r.why}`);
      audit("dream_run", snap ? "changed" : "no-change", "dream", { actions: plan.actions.length, rejected: plan.rejected.length });
      console.log(`dream: ${plan.actions.length} change(s), ${plan.rejected.length} rejected`);
      if (snap) await deps.notify(dreamAnnouncement(plan));
    } catch (e) {
      console.error("dream: failed:", (e as Error).message);
      audit("dream_run", "failed", "dream", { error: (e as Error).message.slice(0, 200) });
    }
  }

  // One run at a time; a second caller waits for the first.
  return { run: (now = new Date()) => (inFlight ??= once(now).finally(() => (inFlight = undefined))) };
}
