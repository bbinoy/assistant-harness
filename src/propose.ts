import { audit } from "./audit.ts";
import { extractMessageId, proposalText, viewDraft } from "./proposals.ts";

// Shows the handler's reply drafts to the owner on Signal (see proposals.ts for how they are sent).

export interface Mail {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
}

const REPLY_TOOLS = new Set(["mcp__mailbird__reply_to_conversation", "mcp__mailbird__reply_all_to_conversation"]);

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

export function createProposer(deps: { mail: Mail; send: (text: string) => Promise<number> }) {
  // The draft as Mailbird holds it now. Also what the approval prompt for a send is built from.
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
        await deps.send(proposalText(view, id));
        audit("reply_proposal", "shown", "handler", { id });
        shown++;
      } catch (e) {
        console.error("proposal: could not show a draft:", (e as Error).message);
      }
    }
    return shown;
  }

  return { show, read };
}
