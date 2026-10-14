import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { isJudgeable, judgeAction, mayAutoApprove, type Verdict } from "./autojudge.ts";
import type { Decision } from "./approvals.ts";
import { describeCall } from "./format.ts";
import { classify, isReadTool } from "./policy.ts";
import { sendApprovalText, type DraftView } from "./proposals.ts";
import { OWNER, settings } from "./settings.ts";

// Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone (the Approve callback).

export type Approve = (
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
) => Promise<Decision>;

// A group run never asks the owner for anything.
export const DENY_ALL: Approve = async () => ({ approved: false });

// Pulls id-like fields (id, conversationId, messageId...) out of tool input for the audit log.
export function idsOf(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const ids = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => /(^id$|Id$)/.test(k) && (typeof v === "string" || typeof v === "number")),
  );
  return Object.keys(ids).length ? { ids } : undefined;
}

// What the owner just said in chat, for the approval judge. A module-level value because the warm
// chat process is built before the message arrives; chat turns run one at a time.
let chatOwnerMessage: string | undefined;
export const setChatOwnerMessage = (text: string) => void (chatOwnerMessage = text);

// Where "done without asking" notices go (set by main).
let autoApprovedNotice: ((text: string) => Promise<void>) | undefined;
export const setAutoApprovedNotice = (fn: (text: string) => Promise<void>) => void (autoApprovedNotice = fn);

const SEND_DRAFT = "mcp__mailbird__send_message_now";
let draftReader: ((messageId: number) => Promise<DraftView | undefined>) | undefined;
// Set by main.ts: reads a draft back from Mailbird, for the approval of a send.
export const setDraftReader = (fn: typeof draftReader) => void (draftReader = fn);

export function makeCanUseTool(approve: Approve, source: Source, memoryDir: string | undefined): CanUseTool {
  return async (tool, input, { signal }) => {
    const verdict = classify(tool, input, source, memoryDir);
    if (verdict === "allow") {
      // Reads log tool + decision only. Writes also log the ids they touch (ids, never
      // content), so "what did it archive?" can always be answered from the audit log.
      audit(tool, "allow", source, isReadTool(tool) ? undefined : idsOf(input));
      return { behavior: "allow", updatedInput: input };
    }
    if (verdict === "deny") {
      audit(tool, "deny-policy", source);
      return { behavior: "deny", message: `${tool} is blocked by policy (or its input is) and cannot be used.` };
    }
    // A small model's second opinion, only for what code puts on the floor (autojudge.ts). In shadow
    // mode it only logs; the owner is asked either way.
    let description = describeCall(tool, input);
    if (tool === SEND_DRAFT) {
      // Show what Mailbird holds right now, not what the model says it is sending. If that cannot
      // be read, the owner would be approving blind, so the send does not happen.
      const id = Number((input as { messageId?: unknown }).messageId);
      const view = draftReader && Number.isFinite(id) ? await draftReader(id).catch(() => undefined) : undefined;
      if (!view || view.to.length === 0) {
        audit(tool, "deny-unreadable-draft", source);
        return { behavior: "deny", message: "That draft could not be read back from Mailbird, so it cannot be shown for approval and was not sent." };
      }
      description = sendApprovalText(view);
    }
    let judged: Verdict | undefined;
    if (settings.autoApprove !== "off" && isJudgeable(tool, input, source)) {
      judged = await judgeAction({ source, description, ownerMessage: source === "chat" ? chatOwnerMessage : undefined });
      audit(tool, `judge-${judged.decision}`, source, { reason: judged.reason, mode: settings.autoApprove });
      if (mayAutoApprove(settings.autoApprove, source, judged)) {
        audit(tool, "auto-approved", source, { reason: judged.reason });
        void autoApprovedNotice?.(`✅ Done without asking: ${description.replace(/\n+/g, " | ").slice(0, 300)}`).catch(() => {});
        return { behavior: "allow", updatedInput: input };
      }
    }
    audit(tool, "ask-sent", source); // logged before the wait, so a stuck approval is visible
    const d = await approve(description, { tool, input }, signal);
    if (judged) audit(tool, "judge-vs-owner", source, { judge: judged.decision, ownerApproved: d.approved });
    audit(
      tool,
      d.approved ? (d.updatedInput ? "ask-approved-modified" : "ask-approved") : d.feedback ? "ask-feedback" : "ask-declined",
      source,
    );
    if (d.approved) return { behavior: "allow", updatedInput: d.updatedInput ?? input };
    return {
      behavior: "deny",
      message: d.feedback
        ? `${OWNER} did NOT approve this call. Instead they replied: ${JSON.stringify(d.feedback)}. Act on that reply. If it changes the request, propose the adjusted call; do not repeat the original unchanged.`
        : `${OWNER} declined, or did not answer in time. Do not retry.`,
    };
  };
}
