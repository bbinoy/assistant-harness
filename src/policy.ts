import type { Source } from "./audit.ts";
import { isNotePath } from "./notes.ts";
import { settings } from "./settings.ts";

// Permissions as code. Every tool call any agent run wants to make passes classify():
//   allow - run it
//   ask   - the owner approves or declines on their phone
//   deny  - never, whatever anyone says
// Unknown tools default to "ask", never to "allow".

export type Verdict = "allow" | "ask" | "deny";

// Hard blocks, checked first so nothing below can override them.
const DENY: RegExp[] = [
  /^mcp__claude_ai_Interactive_Brokers/, // a chat message must never be able to touch trading
  /__(trash|delete|untrash|mark_.*spam|unmark_.*spam|set_sender_blocked|unsubscribe)/i,
];

// No tool may reach local files. Mailbird's create_draft accepts file:// attachments, so an
// injected email could otherwise get ~/.ssh or .env attached to a draft. The agent never needs this.
const LOCAL_FILE = /file:\/\//i;

// Read-only verbs, matched against the tool's own name (after the server name), ignoring a
// "notion-" style prefix: both "get_message" and "notion-fetch" are reads.
const READ_VERB = /^(list|get|search|read|query|fetch|summarize|suggest|whats|download|show|ai-search)/i;

export function isReadTool(tool: string): boolean {
  const name = (tool.split("__").pop() ?? "").replace(/^notion-/i, "");
  return READ_VERB.test(name);
}

// In-thread reply drafts: never sent, the owner sees them in their mail client.
const DRAFT_REPLIES = new Set(["mcp__mailbird__reply_to_conversation", "mcp__mailbird__reply_all_to_conversation"]);

// Writes chat and the daily brief may do unattended. All reversible or draft-only.
const ROUTINE_WRITES = new Set([
  ...DRAFT_REPLIES,
  "mcp__mailbird__archive_conversation",
  "mcp__mailbird__select_conversation",
  "mcp__mailbird__create_draft",
  "mcp__mailbird__update_draft",
  "mcp__mailbird__send_self_briefing", // can only ever send to the owner
  "mcp__claude_ai_Notion__notion-create-pages",
  "mcp__claude_ai_Notion__notion-update-page",
]);

// Least privilege by who is acting. The mail handler reads untrusted email with nobody
// watching, so on its own it may only leave reply drafts; anything else it must ask for.
const UNATTENDED_WRITES: Record<Source, ReadonlySet<string>> = {
  chat: ROUTINE_WRITES,
  brief: ROUTINE_WRITES,
  handler: DRAFT_REPLIES,
  heartbeat: new Set(), // the heartbeat itself never runs an agent
};

// The owner's memory is the SDK's auto-memory: the chat agent keeps small notes in
// memory/notes/ with the built-in Read, Write and Edit tools, plus our forget_note. Those tools
// are allowed for chat ONLY on a path inside that folder (anywhere else is denied), and every
// change is announced on the phone with how to undo it (agent.ts), so a note planted by
// something the agent read is seen at once. Nothing unattended may touch them. Checked before
// any allow list, so adding them to one can never open them up.
const NOTE_FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
const FORGET_NOTE = "mcp__memory__forget_note";

// --- what the model never sees ---
// Every tool schema the model can see is re-sent on every model call, so hiding tools nobody
// uses is the biggest saving there is: Notion alone was ~58k tokens of a ~118k floor, one of
// its tools 21k. Hidden: the connectors in HIDDEN_CONNECTORS, Notion beyond NOTION_TOOLS, Mailbird beyond MAILBIRD_TOOLS, and
// anything policy denies for everyone anyway (it could never run). Both lists are settings
// (.env): a skill that needs a hidden tool fails, so keep them in step with your skills.
const NOTION = "mcp__claude_ai_Notion__";
const MAILBIRD = "mcp__mailbird__";

// Names come from the tools a run has seen (agent.ts records them), so a tool a connector
// adds later is hidden from the run after the one that first saw it.
export function hiddenTools(
  seen: readonly string[],
  cfg: { hiddenConnectors: readonly string[]; notionTools: readonly string[]; mailbirdTools: readonly string[] } = settings,
): string[] {
  const notion = new Set(cfg.notionTools);
  const mail = new Set(cfg.mailbirdTools);
  const extra = seen.filter(
    (t) => (t.startsWith(NOTION) && !notion.has(t.slice(NOTION.length))) || (t.startsWith(MAILBIRD) && !mail.has(t.slice(MAILBIRD.length))) || DENY.some((re) => re.test(t)),
  );
  return [...cfg.hiddenConnectors, ...new Set(extra)];
}

export function classify(tool: string, input: Record<string, unknown>, source: Source): Verdict {
  if (DENY.some((re) => re.test(tool))) return "deny";
  if (LOCAL_FILE.test(JSON.stringify(input))) return "deny";
  if (NOTE_FILE_TOOLS.has(tool)) return source === "chat" && isNotePath(input.file_path) ? "allow" : "deny";
  if (tool === FORGET_NOTE) return source === "chat" ? "allow" : "deny";
  if (tool === "Skill" || isReadTool(tool)) return "allow";
  return UNATTENDED_WRITES[source].has(tool) ? "allow" : "ask";
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
