import { renameSync, statSync } from "node:fs";
import { appendLine, dataPath, readText } from "./state.ts";

// One append-only log for everything the agent does or observes.
//   source: who acted (a chat turn, the daily brief, the mail handler, the heartbeat itself)
//   meta:   small structured details. Agent tool calls log ids only, never content; heartbeat
//           triage entries add sender and subject so the brief and `npm run report` can list them.

export type Source = "chat" | "brief" | "handler" | "heartbeat" | "radar" | "dream";

export interface AuditEntry {
  ts: string;
  source: Source;
  tool: string;
  decision: string;
  meta?: Record<string, any>;
}

const FILE = "logs/audit.jsonl";
const MAX_BYTES = 20 * 1024 * 1024;
let appends = 0;

export function audit(tool: string, decision: string, source: Source, meta?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), source, tool, decision, ...(meta ? { meta } : {}) };
  appendLine(FILE, JSON.stringify(entry));
  // Keep one previous generation; readers only ever need the recent past.
  if (++appends % 100 === 0 && statSync(dataPath(FILE)).size > MAX_BYTES) {
    renameSync(dataPath(FILE), dataPath(`${FILE}.1`));
  }
}

// Entries matching `keep`, oldest first. A damaged line is skipped, never fatal.
export function readAudit(keep: (e: AuditEntry) => boolean): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of (readText(FILE) ?? "").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (keep(e)) out.push(e);
    } catch {
      /* skip */
    }
  }
  return out;
}

// What the heartbeat decided about each new email (archived, alerted, kept...).
export const isTriage = (e: AuditEntry) => e.source === "heartbeat" && e.tool === "heartbeat_triage";
