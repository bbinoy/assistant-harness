import { audit, type Source } from "./audit.ts";
import * as approvals from "./approvals.ts";
import type { Approve } from "./permissions.ts";
import { recentChat } from "./recentchat.ts";
import { composeQuestion } from "./softjudge.ts";
import { settings } from "./settings.ts";

// Asking the owner, per APPROVAL_STYLE. strict and soft: the code text goes out as it is. conversational: a model writes the question,
// a second independent call checks it against the exact arguments, and the code text is the fallback (softjudge.ts composeQuestion).
// In both soft styles the ask is audited with the FULL arguments, the exact text sent and, afterwards, the outcome and whether the
// call that ran has the arguments the question was written for, so a divergence between intent and behaviour can be investigated.

const MAX_ARGS = 6000;
// Full arguments, size-capped; audit() redacts secrets in the whole line.
export const argsForAudit = (input: Record<string, unknown>): unknown => {
  const json = JSON.stringify(input);
  return json.length <= MAX_ARGS ? input : `${json.slice(0, MAX_ARGS)}… (+${json.length - MAX_ARGS} more characters)`;
};

// Plain equality of two argument sets (key order does not matter).
export const sameArgs = (a: unknown, b: unknown): boolean => {
  const k = (v: unknown): unknown => (Array.isArray(v) ? v.map(k) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([n, x]) => [n, k(x)])) : v);
  return JSON.stringify(k(a)) === JSON.stringify(k(b));
};

export function makeApprove(send: (text: string) => Promise<number>, background: boolean, request: typeof approvals.request = approvals.request): Approve {
  const source: Source = background ? "background" : "chat";
  return async (description, call, abort) => {
    if (settings.approvalStyle === "strict") return request(send, description, call, abort, { background });
    let question = description;
    let how = "code text";
    let composed: Awaited<ReturnType<typeof composeQuestion>> | undefined;
    if (settings.approvalStyle === "conversational") {
      composed = await composeQuestion({ tool: call.tool, args: call.input, details: description, recent: recentChat(), background, source });
      question = composed.text;
      how = composed.written ? "model-written, checked" : "code text (fallback)";
    }
    const asked = structuredClone(call.input);
    audit(call.tool, "approval-asked", source, { style: settings.approvalStyle, wording: how, args: argsForAudit(asked), question, details: description, ...(composed ? { attempts: composed.attempts, mismatches: composed.mismatches, failure: composed.failure } : {}) });
    const d = await request(send, description, call, abort, { background, question });
    // Post-hoc, never blocking: is what will run what the question was written for?
    audit(call.tool, "approval-outcome", source, { approved: d.approved, modified: !!d.updatedInput, argsEqual: sameArgs(asked, d.updatedInput ?? call.input), ...(d.feedback ? { feedback: d.feedback.slice(0, 300) } : {}), ...(d.updatedInput ? { executed: argsForAudit(d.updatedInput) } : {}) });
    return d;
  };
}
