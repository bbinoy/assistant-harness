export type Verdict = "allow" | "ask" | "deny";

// Hard blocks. Evaluated first, so nothing below can override them.
const DENY: RegExp[] = [
  /^mcp__claude_ai_Interactive_Brokers/, // a chat message must never be able to touch trading
  /__(trash|delete|untrash|mark_.*spam|unmark_.*spam|set_sender_blocked|unsubscribe)/i,
];

// Read-only verbs: safe to run without asking. Matched against the tool's own name
// (the part after the server name), ignoring a "notion-" style prefix, so both
// "get_message" and "notion-fetch" count as reads.
const READ_VERB = /^(list|get|search|read|query|fetch|summarize|suggest|whats|download|show|ai-search)/i;

export function isReadTool(tool: string): boolean {
  const name = (tool.split("__").pop() ?? "").replace(/^notion-/i, "");
  return READ_VERB.test(name);
}

// Writes the routine runner already performs unattended (see assistant-run.sh):
// archive, drafts, the self-briefing, Notion edits. Archive is reversible; drafts never send.
const ROUTINE_WRITES = new Set([
  "mcp__mailbird__archive_conversation",
  "mcp__mailbird__select_conversation",
  "mcp__mailbird__reply_to_conversation",
  "mcp__mailbird__reply_all_to_conversation",
  "mcp__mailbird__create_draft",
  "mcp__mailbird__update_draft",
  "mcp__mailbird__send_self_briefing",
  "mcp__claude_ai_Notion__notion-create-pages",
  "mcp__claude_ai_Notion__notion-update-page",
]);

export function classify(tool: string): Verdict {
  if (DENY.some((re) => re.test(tool))) return "deny";
  if (tool === "Skill") return "allow";
  if (ROUTINE_WRITES.has(tool)) return "allow";
  if (isReadTool(tool)) return "allow";
  // Everything else is unknown or outward-facing (send, forward, calendar
  // changes, sharing...): a human decides.
  return "ask";
}

// --- "yes, but make it 16:00": consent with a small edit, applied without re-asking ---

// Only low-risk, non-sending tools may be edited-and-approved in one reply.
// Everything else (send, forward, share...) goes back through a fresh approval.
const MODIFIABLE = new Set([
  "mcp__claude_ai_Google_Calendar__create_event",
  "mcp__claude_ai_Google_Calendar__update_event",
]);

// Fields that decide who is affected. Never changeable through a chat reply.
const PROTECTED_FIELD = /^(to|cc|bcc|attendees?|recipients?|emails?|calendarId|guests?)$/i;

export interface Change {
  field: string;
  value: string;
}

export function isModifiable(tool: string): boolean {
  return MODIFIABLE.has(tool);
}

// Returns the patched input, or undefined if the patch is not acceptable
// (the caller then falls back to the normal deny-with-feedback path).
export function applyChanges(
  tool: string,
  input: Record<string, unknown>,
  changes: Change[],
): Record<string, unknown> | undefined {
  if (!isModifiable(tool) || changes.length === 0 || changes.length > 4) return undefined;
  const patched = { ...input };
  for (const { field, value } of changes) {
    if (!Object.hasOwn(input, field)) return undefined; // no new fields
    if (PROTECTED_FIELD.test(field)) return undefined;
    if (typeof input[field] !== "string" || typeof value !== "string" || value.length > 200) return undefined;
    patched[field] = value;
  }
  return patched;
}
