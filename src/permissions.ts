import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { isJudgeable, judgeAction, mayAutoApprove, type Verdict } from "./autojudge.ts";
import type { Decision } from "./approvals.ts";
import { describeCall } from "./format.ts";
import { classify, isReadTool } from "./policy.ts";
import type { DraftView } from "./proposals.ts";
import { actionOf, entryFor, mailView, type MailView } from "./toolmanifest.ts";
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

// What the owner just said in chat, and the two messages before it, for the approval judge (a send is judged against what was said
// about it, which may have been a message ago: "reply to Armon that Tuesday works" ... "send it"). A module-level value because
// the warm chat process is built before the message arrives; chat turns run one at a time.
let chatOwnerMessages: string[] = [];
export const setChatOwnerMessage = (text: string) => void (chatOwnerMessages = [...chatOwnerMessages, text].slice(-3));
const MAIL_OUT = new Set(["send", "reply", "forward"]); // actions that put mail in front of other people, judged against the owner's words
// An action the owner approved is done: the same call again (same tool, same arguments) within half an hour is refused
// without a question, because repeating it would send, create or change it twice (a model once retried a send after a
// slow status check). A DECLINED call can still be asked again.
const DONE_WINDOW_MS = 30 * 60_000;
const done = new Map<string, number>();
// Keys sorted at every depth. (A JSON.stringify key-list replacer also filters NESTED keys, so two events that differ only
// in start.dateTime had the same key and the second was refused as "already done".)
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, stable(x)])) : v);
export const callKey = (tool: string, input: Record<string, unknown>) => `${tool} ${JSON.stringify(stable(input))}`;
// Entries older than the window can never match again, so they are dropped as new ones come in (the map cannot grow without end).
const remember = (key: string) => {
  const now = Date.now();
  for (const [k, at] of done) if (now - at >= DONE_WINDOW_MS) done.delete(k);
  done.set(key, now);
};
// Only for actions that change something: opening a page again is harmless, and refusing it would just get in the way.
export const doneCount = () => done.size; // tests
const once = (tool: string) => tool !== "WebFetch" && !isReadTool(tool);
let draftReader: ((messageId: number) => Promise<DraftView | undefined>) | undefined;
// Set by main.ts: reads a draft back from Mailbird, for the approval of a send.
export const setDraftReader = (fn: typeof draftReader) => void (draftReader = fn);

export function makeCanUseTool(approve: Approve, source: Source, memoryDir: string | undefined, judgeContext?: string, judge: typeof judgeAction = judgeAction): CanUseTool {
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
    const key = callKey(tool, input);
    const doneAt = once(tool) ? done.get(key) : undefined;
    if (doneAt !== undefined && Date.now() - doneAt < DONE_WINDOW_MS) {
      audit(tool, "deny-already-done", source);
      return { behavior: "deny", message: "That exact call was already approved and done a moment ago. Do not repeat it; check its result once if you need to be sure it went through." };
    }
    let description = describeCall(tool, input);
    let view: MailView | undefined;
    if (MAIL_OUT.has(actionOf(tool))) {
      // Show what the mail client holds right now, not what the model says it is sending (a send of a draft), and the same view for
      // every provider. If that cannot be read, the owner would be approving blind, so the send does not happen.
      const id = Number((input as { messageId?: unknown }).messageId);
      const fromDraft = entryFor(tool)?.view === "mbSend";
      const draft = fromDraft && draftReader && Number.isFinite(id) ? await draftReader(id).catch(() => undefined) : undefined;
      view = mailView(tool, input, draft && { ...draft, bcc: draft.bcc ?? [], hasAttachments: draft.hasAttachments ?? false });
      if (!view || (view.action !== "forward" && view.to.length === 0)) {
        audit(tool, "deny-unreadable-draft", source);
        return { behavior: "deny", message: "That mail could not be read back, so it cannot be shown for approval and was not sent." };
      }
      description = describeCall(tool, input, view);
    }
    let judged: Verdict | undefined;
    const [ownerMessage, ...earlier] = [...chatOwnerMessages].reverse();
    // A chat send is judged against the owner's words; with none on record there is nothing to judge it against.
    if (settings.autoApprove !== "off" && isJudgeable(tool, input, source, view) && (view === undefined || (source === "chat" && ownerMessage !== undefined))) {
      judged = await judge({ source, description, ownerMessage: source === "chat" ? ownerMessage : undefined, earlier: source === "chat" ? earlier.reverse() : undefined, task: source === "chat" ? undefined : judgeContext });
      audit(tool, `judge-${judged.decision}`, source, { reason: judged.reason, mode: settings.autoApprove });
      if (mayAutoApprove(settings.autoApprove, source, judged)) {
        audit(tool, "auto-approved", source, { reason: judged.reason }); // silent on purpose: logged, never announced (npm run report shows them)
        if (once(tool)) remember(key);
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
    if (d.approved && once(tool)) remember(key);
    if (d.approved) return { behavior: "allow", updatedInput: d.updatedInput ?? input };
    return {
      behavior: "deny",
      message: d.feedback
        ? `${OWNER} did NOT approve this call. Instead they replied: ${JSON.stringify(d.feedback)}. Act on that reply. If it changes the request, propose the adjusted call; do not repeat the original unchanged.`
        : `${OWNER} declined, or did not answer in time. Do not retry.`,
    };
  };
}
