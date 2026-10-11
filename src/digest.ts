import { isTriage, readAudit, type AuditEntry } from "./audit.ts";

export type TriageEntry = Pick<AuditEntry, "ts" | "decision"> & {
  meta: { id?: string; messageId?: number; from?: string; subject?: string; label?: string; kind?: string };
};

export function readTriageSince(sinceIso: string): TriageEntry[] {
  return readAudit((e) => isTriage(e) && e.ts > sinceIso) as TriageEntry[];
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
