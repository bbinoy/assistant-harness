import { audit } from "./audit.ts";
import { addProposal, extractMessageId, hashBody, proposalText, stillAsShown, takeProposal, viewDraft, type Proposal } from "./proposals.ts";

// Shows the handler's reply drafts to the owner and sends one on 👍 (see proposals.ts for why
// this is safe). The model is not involved in sending: the draft id comes from the tool result,
// the text and recipients are read back from Mailbird, and the send is the owner's gesture.

export interface Mail {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

const REPLY_TOOLS = new Set(["mcp__mailbird__reply_to_conversation", "mcp__mailbird__reply_all_to_conversation"]);
const YES = new Set(["👍", "✅"]);
const NO = new Set(["👎", "❌"]);

// For the handler's hook: remembers the id of each reply draft a tool call created.
export function draftCollector() {
  const ids: number[] = [];
  return {
    ids,
    onToolSuccess(tool: string, _input: unknown, response?: unknown) {
      if (!REPLY_TOOLS.has(tool)) return;
      const id = extractMessageId(response);
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    },
  };
}

export function createProposer(deps: { mail: Mail; send: (text: string) => Promise<number>; say: (text: string) => Promise<void> }) {
  async function read(draftMessageId: number) {
    return viewDraft(await deps.mail.call("get_message", { messageId: draftMessageId }));
  }

  // Shows each draft on Signal. A draft that cannot be read, or has no recipient, is skipped:
  // it is still in the owner's mailbox as a draft.
  async function show(draftIds: readonly number[]): Promise<number> {
    let shown = 0;
    for (const id of draftIds) {
      try {
        const view = await read(id);
        if (!view || view.to.length === 0) continue;
        const ts = await deps.send(proposalText(view));
        addProposal({ ts, draftMessageId: id, to: view.to, subject: view.subject, bodyHash: hashBody(view.body), at: new Date().toISOString() });
        audit("reply_proposal", "shown", "handler", { id });
        shown++;
      } catch (e) {
        console.error("proposal: could not show a draft:", (e as Error).message);
      }
    }
    return shown;
  }

  // A reaction on a Signal message. Returns true if it belonged to a proposal.
  async function onReaction(emoji: string, targetTimestamp: number): Promise<boolean> {
    const e = emoji.replace(/[︎️]/g, "");
    if (!YES.has(e) && !NO.has(e)) return false;
    const p: Proposal | undefined = takeProposal(targetTimestamp);
    if (!p) return false;
    if (NO.has(e)) {
      audit("reply_proposal", "declined", "chat", { id: p.draftMessageId });
      await deps.say("Okay, I left the draft in your mailbox. It is not sent.");
      return true;
    }
    try {
      const view = await read(p.draftMessageId);
      const check = stillAsShown(p, view);
      if (!check.ok) {
        audit("reply_proposal", `not-sent: ${check.why}`, "chat", { id: p.draftMessageId });
        // Show the current text again, so a 👍 on that one sends what is there now.
        if (view && view.to.length > 0) {
          await deps.say(`I did not send it: ${check.why}. Here is the draft as it is now.`);
          await show([p.draftMessageId]);
        } else {
          await deps.say(`I did not send it: ${check.why}.`);
        }
        return true;
      }
      await deps.mail.call("send_message_now", { messageId: p.draftMessageId, confirm: true });
      audit("reply_proposal", "sent", "chat", { id: p.draftMessageId });
      await deps.say(`✅ Sent to ${p.to.join(", ")}.`);
    } catch (err) {
      console.error("proposal: send failed:", (err as Error).message);
      audit("reply_proposal", "send-failed", "chat", { id: p.draftMessageId });
      await deps.say(`I could not send it (${(err as Error).message.slice(0, 80)}). The draft is still in your mailbox.`);
    }
    return true;
  }

  return { show, onReaction };
}
