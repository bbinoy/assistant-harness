import type { AuditEntry } from "./audit.ts";
import { localTime } from "./pause.ts";

// `npm run report`: each approval ask (APPROVAL_STYLE soft / conversational) with the exact arguments next to the question that was
// sent and what became of it, for review. Newest last. A line "ARGUMENTS DIFFER" means the call that ran was not the one asked about
// (and no edit was applied): the thing to investigate.
export const APPROVAL_DECISIONS = ["approval-asked", "approval-outcome", "question-mismatch"];

export function approvalLines(entries: readonly AuditEntry[], max = 12): string[] {
  const asks = entries.filter((e) => e.decision === "approval-asked");
  const outcomes = entries.filter((e) => e.decision === "approval-outcome");
  const lines: string[] = [];
  for (const e of asks.slice(-max)) {
    const m = e.meta ?? {};
    const after = outcomes.find((o) => o.ts >= e.ts && o.tool === e.tool && o.source === e.source);
    const result = after ? `${after.meta?.approved ? "approved" : "not approved"}${after.meta?.modified ? " (edited)" : ""}${after.meta?.argsEqual === false ? ", ARGUMENTS DIFFER from the ask" : ""}` : "no outcome logged";
    lines.push(`  ${localTime(e.ts)} ${e.tool} [${m.style}, ${m.wording}${m.attempts > 1 ? `, ${m.attempts} tries` : ""}] -> ${result}`);
    lines.push(`    arguments: ${(typeof m.args === "string" ? m.args : JSON.stringify(m.args)).slice(0, 600)}`);
    lines.push(`    question:  ${String(m.question).replace(/\s*\n\s*/g, " / ").slice(0, 600)}`);
  }
  if (asks.length) {
    const refused = entries.filter((e) => e.decision === "question-mismatch").length;
    const differ = outcomes.filter((o) => o.meta?.argsEqual === false && !o.meta?.modified).length;
    lines.push(`  ${asks.length} ask(s); the independent check refused ${refused} written question(s); calls whose arguments differ from the ask (no edit): ${differ}`);
  }
  return lines;
}
