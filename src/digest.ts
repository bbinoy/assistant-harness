import { readFile } from "node:fs/promises";

const AUDIT_FILE = new URL("../state/audit.jsonl", import.meta.url);

export interface TriageEntry {
  ts: string;
  decision: string; // "archived" | "would-archive" | "would-act_now" | ...
  meta: { id?: string; messageId?: number; from?: string; subject?: string; label?: string; kind?: string };
}

export async function readTriageSince(sinceIso: string | undefined): Promise<TriageEntry[]> {
  let raw: string;
  try {
    raw = await readFile(AUDIT_FILE, "utf8");
  } catch {
    return [];
  }
  const out: TriageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.source === "heartbeat" && e.tool === "heartbeat_triage" && (!sinceIso || e.ts > sinceIso)) out.push(e);
    } catch {
      /* skip a damaged line rather than lose the whole digest */
    }
  }
  return out;
}

const LIST_CAP = 40;
const clip = (s: string | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

// What the heartbeat did with new mail since the last brief, as plain text for the
// brief prompt. Pure function: easy to test.
export function buildDigest(entries: TriageEntry[], sinceIso: string | undefined): string {
  const head = `HEARTBEAT DIGEST (since ${sinceIso ?? "the beginning"}, ${entries.length} new conversation(s) triaged)`;
  if (entries.length === 0) return `${head}\nNothing new arrived.`;

  const logOnly = entries.every((e) => e.decision.startsWith("would-"));
  const lines = [head];
  if (logOnly) {
    lines.push("Heartbeat was in LOG-ONLY mode: it archived nothing. Labels below are its classifications, not actions taken.");
  }
  const by = (label: string) => entries.filter((e) => e.meta.label === label);
  const archived = entries.filter((e) => e.decision === "archived");
  const candidates = entries.filter((e) => e.meta.label === "archive" && e.decision !== "archived");
  const section = (title: string, rows: TriageEntry[], withKind: boolean) => {
    if (rows.length === 0) return;
    lines.push(`\n${title} (${rows.length}):`);
    for (const e of rows.slice(0, LIST_CAP)) {
      const kind = withKind ? ` [${e.meta.kind}]` : "";
      const id = e.meta.messageId ? ` {msg ${e.meta.messageId}}` : "";
      lines.push(`- ${clip(e.meta.from, 40)}: ${clip(e.meta.subject, 90)}${kind}${id}`);
    }
    if (rows.length > LIST_CAP) lines.push(`- ...and ${rows.length - LIST_CAP} more`);
  };
  section("Archived by the heartbeat (include newsletters in the radar)", archived, true);
  section("Looked archivable but were left in the inbox", candidates, true);
  section("Needs the owner (act_now; the heartbeat sends a phone alert only once the day's brief is out, so overnight mail is reported here instead)", by("act_now"), false);
  section("Assistant can handle", by("handle"), false);
  section("Read later (left in inbox)", by("read_later"), false);
  return lines.join("\n");
}
