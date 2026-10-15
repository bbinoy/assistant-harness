import { audit, type Source } from "./audit.ts";
import * as approvals from "./approvals.ts";
import type { Approve } from "./permissions.ts";
import { recentChat } from "./recentchat.ts";
import { composeQuestion } from "./softjudge.ts";
import { settings } from "./settings.ts";

// Asking the owner, per APPROVAL_STYLE. strict and soft: the code text goes out as it is. conversational: a model writes the question
// in one call and code validates it against the exact arguments (softjudge.ts, questionfacts.ts); if that fails nothing is asked.
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

// `scope`: the conversation the question is asked in (a group id, or the owner's chat): only an answer there applies.
export function makeApprove(send: (text: string) => Promise<number>, background: boolean, request: typeof approvals.request = approvals.request, compose: typeof composeQuestion = composeQuestion, scope: string = approvals.OWNER_SCOPE): Approve {
  const source: Source = scope !== approvals.OWNER_SCOPE ? "group" : background ? "background" : "chat";
  return async (description, call, abort) => {
    if (settings.approvalStyle === "strict") return request(send, description, call, abort, { background, scope });
    let question = description;
    let how = "code text";
    let ms: number | undefined;
    if (settings.approvalStyle === "conversational") {
      // One model call writes it, code validates it. No question means no ask and no card: the agent gets the failure as the tool result.
      const c = await compose({ tool: call.tool, args: call.input, details: description, recent: scope === approvals.OWNER_SCOPE ? recentChat() : [], background, source });
      if (c.text === undefined) return { approved: false, failure: `no question could be written that states the exact arguments (${c.failure})` };
      question = c.text;
      how = "model-written, validated";
      ms = c.ms;
    }
    const asked = structuredClone(call.input);
    audit(call.tool, "approval-asked", source, { style: settings.approvalStyle, wording: how, args: argsForAudit(asked), question, details: description, ...(ms !== undefined ? { writeMs: ms } : {}) });
    const d = await request(send, description, call, abort, { background, question, scope });
    // Post-hoc, never blocking: is what will run what the question was written for?
    audit(call.tool, "approval-outcome", source, { approved: d.approved, modified: !!d.updatedInput, argsEqual: sameArgs(asked, d.updatedInput ?? call.input), ...(d.feedback ? { feedback: d.feedback.slice(0, 300) } : {}), ...(d.updatedInput ? { executed: argsForAudit(d.updatedInput) } : {}) });
    return d;
  };
}
