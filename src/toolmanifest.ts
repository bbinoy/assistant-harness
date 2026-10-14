import type { Source } from "./audit.ts";
import { settings } from "./settings.ts";

// THE tool manifest: every tool the model might get declares here whether it needs the owner's approval, so one rule
// applies the same way across mail providers and other tools. policy.ts, autojudge.ts, permissions.ts and format.ts read
// this table; none keeps a tool list of its own.
//
// The approval flag:
//   no   - runs without asking
//   auto - the Haiku approval judge decides: go ahead, or ask the owner (autojudge.ts; code vetoes first)
//   yes  - always asks on the phone
// A flag is one value, or per who is acting: `chat`, `unattended` (every other source) or one named source, which wins
// over `unattended`. A source a flag does not name is `yes`. A tool that is not here is `yes` too, unless its name is a
// read verb. `only` limits a tool to some sources; anywhere else it is denied outright (policy.ts classify).
// Not here, on purpose: the never-allowed set (policy.ts DENY: trading, trash/delete/spam/unsubscribe) and a group's
// rights (classify). They are not flag values.

export type Flag = "no" | "auto" | "yes";
export type FlagSpec = Flag | Partial<Record<"chat" | "unattended" | Source, Flag>>;
export type ViewKind = "mbSend" | "mbDraft" | "mbReply" | "mbForward" | "gmSend" | "gmReply" | "gmForward" | "gmDraft";

export interface ToolEntry {
  tool: string;
  provider: string; // mailbird, gmail, calendar, notion, drive, docs, builtin, memory
  action: string; // read, draft, reply-draft, send, reply, forward, archive, restore, label, select, send-self, calendar-write, ...
  flag: FlagSpec;
  only?: readonly Source[];
  view?: ViewKind; // a mail tool: how mailView() reads its input
}

// Mailbird's and the Gmail connector's mail provider tags: an entry takes effect only while that provider is the active one.
export const MAIL_PROVIDERS = ["mailbird", "gmail"];

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const NOTION = "mcp__claude_ai_Notion__";
const DRIVE = "mcp__claude_ai_Google_Drive__";

// Reversible or draft-only upkeep that chat and the daily brief may do unattended.
const ROUTINE: FlagSpec = { chat: "no", brief: "no" };
// In chat the judge decides a send from the owner's words and the exact draft; every unattended run (the mail handler reads raw untrusted mail) asks.
const SEND: FlagSpec = { chat: "auto", unattended: "yes" };

type Opts = { only?: readonly Source[]; view?: ViewKind };
const rows = (prefix: string, provider: string, action: string, flag: FlagSpec, names: string, o: Opts = {}): ToolEntry[] =>
  names.split(" ").map((n) => ({ tool: prefix + n, provider, action, flag, ...o }));

export const MANIFEST: readonly ToolEntry[] = [
  // --- Mailbird ---
  ...rows(MB, "mailbird", "read", "no", "summarize_all_inboxes list_accounts list_folders list_conversations search_conversations get_message get_conversation list_attachments get_attachment_content get_send_status get_help get_ui_state"),
  ...rows(MB, "mailbird", "archive", ROUTINE, "archive_conversation"),
  ...rows(MB, "mailbird", "restore", ROUTINE, "move_conversation_to_inbox"),
  ...rows(MB, "mailbird", "select", ROUTINE, "select_conversation"),
  ...rows(MB, "mailbird", "draft", ROUTINE, "create_draft update_draft", { view: "mbDraft" }),
  // In-thread reply drafts: never sent, so the mail handler may leave them too.
  ...rows(MB, "mailbird", "reply-draft", { chat: "no", brief: "no", handler: "no" }, "reply_to_conversation reply_all_to_conversation", { view: "mbReply" }),
  ...rows(MB, "mailbird", "send-self", ROUTINE, "send_self_briefing"), // can only ever reach the owner
  ...rows(MB, "mailbird", "send", SEND, "send_message_now", { view: "mbSend" }),
  ...rows(MB, "mailbird", "forward", SEND, "forward_conversation", { view: "mbForward" }), // Mailbird only saves a draft here; recipients are set later
  // --- Gmail connector: data for later, takes effect only when MAIL_PROVIDER=gmail ---
  ...rows(GM, "gmail", "read", "no", "search_threads get_thread get_message get_draft list_drafts list_labels"),
  ...rows(GM, "gmail", "draft", ROUTINE, "create_draft update_draft", { view: "gmDraft" }),
  ...rows(GM, "gmail", "send", SEND, "send_message", { view: "gmSend" }),
  ...rows(GM, "gmail", "reply", SEND, "reply", { view: "gmReply" }),
  ...rows(GM, "gmail", "forward", SEND, "forward", { view: "gmForward" }),
  ...rows(GM, "gmail", "archive", ROUTINE, "unlabel_thread"), // removing INBOX is an archive; undoing it adds a label, which asks (it could add TRASH)
  ...rows(GM, "gmail", "label", "yes", "label_thread label_message unlabel_message update_message_labels create_label update_label apply_sensitive_message_label apply_sensitive_thread_label"),
  // --- Calendar ---
  ...rows(CAL, "calendar", "read", "no", "list_calendars list_events get_event search_events suggest_time"),
  ...rows(CAL, "calendar", "calendar-write", "auto", "create_event"), // the guest floor is a code veto (autojudge.ts)
  ...rows(CAL, "calendar", "calendar-write", { chat: "auto" }, "update_event"), // an existing event may have guests who would be emailed: judged in chat only
  ...rows(CAL, "calendar", "calendar-respond", "yes", "respond_to_event"),
  // --- Notion, Drive, Docs ---
  ...rows(NOTION, "notion", "read", "no", "notion-fetch notion-search"),
  ...rows(NOTION, "notion", "page-write", { chat: "no", brief: "no", radar: "no" }, "notion-create-pages notion-update-page"),
  ...rows(NOTION, "notion", "comment-write", "yes", "notion-create-comment"),
  ...rows(DRIVE, "drive", "read", "no", "search_files read_file_content download_file_content get_file_metadata get_file_permissions list_recent_files"),
  ...rows(DRIVE, "drive", "drive-write", "yes", "create_file update_file copy_file"),
  ...rows(DRIVE, "drive", "share", "yes", "share_file"),
  ...rows("mcp__claude_ai_Google_Docs__", "docs", "read", "no", "read_doc"),
  ...rows("mcp__claude_ai_Google_Docs__", "docs", "doc-write", "yes", "update_doc"),
  // --- the assistant's own: web, skills, notes ---
  ...rows("", "builtin", "web-search", "no", "WebSearch", { only: ["chat", "background"] }), // a search query is a small channel out, accepted where the owner is behind the run
  ...rows("", "builtin", "web-fetch", { chat: "auto", background: "auto", brief: "auto", radar: "auto" }, "WebFetch", { only: ["chat", "background", "brief", "radar"] }), // never the mail handler; the plain-address veto is code
  ...rows("", "builtin", "skill", "no", "Skill"), // which skills load is limited by the SDK's skills allowlist (agent.ts)
  // The file tools are chat only; WHICH path is code (policy.ts classify), a flag cannot say that.
  ...rows("", "builtin", "note-file", "no", "Read Write Edit", { only: ["chat"] }),
  ...rows("mcp__memory__", "memory", "memory", "no", "forget_note search_logs undo_dream", { only: ["chat"] }),
];

// Read verbs, matched against the tool's own name (after the server name), ignoring a "notion-" style prefix: both
// "get_message" and "notion-fetch" are reads. Covers the read tools nobody listed above.
const READ_VERB = /^(list|get|search|read|query|fetch|summarize|suggest|whats|download|show|ai-search)/i;
const readVerb = (tool: string) => READ_VERB.test((tool.split("__").pop() ?? "").replace(/^notion-/i, ""));

export type MailProvider = "none" | "mailbird" | "gmail"; // settings.mailProvider cannot be gmail yet; the data can already be

// A mail provider's entries count only while it is the active one; every other provider's always do.
const active = (e: ToolEntry, mail: MailProvider) => !MAIL_PROVIDERS.includes(e.provider) || e.provider === mail;

const cache = new Map<MailProvider, Map<string, ToolEntry>>();
export function entryFor(tool: string, mail: MailProvider = settings.mailProvider): ToolEntry | undefined {
  let m = cache.get(mail);
  if (!m) cache.set(mail, (m = new Map(MANIFEST.filter((e) => active(e, mail)).map((e) => [e.tool, e]))));
  return m.get(tool);
}

export const actionOf = (tool: string, mail?: MailProvider): string => entryFor(tool, mail)?.action ?? (readVerb(tool) ? "read" : "unknown");
export const isReadTool = (tool: string): boolean => actionOf(tool) === "read";

// The flag for this tool and source; undefined: not allowed for this source at all (deny).
export function flagFor(tool: string, source: Source, mail?: MailProvider): Flag | undefined {
  const e = entryFor(tool, mail);
  if (!e) return readVerb(tool) ? "no" : "yes";
  if (e.only && !e.only.includes(source)) return undefined;
  return typeof e.flag === "string" ? e.flag : (e.flag[source] ?? (source === "chat" ? undefined : e.flag.unattended) ?? "yes");
}

// --- one view of an outgoing mail call, whatever the provider ---

export type MailAction = "send" | "reply" | "forward" | "draft";
export interface MailView {
  action: MailAction;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  hasAttachments: boolean;
}

// Pure: recipients as lower-case addresses, from strings or {email|address} objects.
export function addrs(v: unknown): string[] {
  return (Array.isArray(v) ? v : v ? [v] : [])
    .map((x) => String((x as { email?: string; address?: string })?.email ?? (x as { address?: string })?.address ?? x).trim().toLowerCase())
    .filter(Boolean);
}

type In = Record<string, unknown>;
const native = (action: MailAction, i: In): MailView => ({
  action,
  to: addrs(i.to),
  cc: addrs(i.cc),
  bcc: addrs(i.bcc),
  subject: String(i.subject ?? ""),
  body: String(i.body ?? i.htmlBody ?? i.forwardText ?? ""),
  hasAttachments: Array.isArray(i.attachments) && i.attachments.length > 0,
});

// A send of an existing draft (a Mailbird messageId, a Gmail draftId) has no content in its input: it is shown from the draft as
// read back, or not at all. A view that cannot be made means the call cannot be shown for approval.
const VIEWS: Record<ViewKind, (i: In, draft?: Omit<MailView, "action">) => MailView | undefined> = {
  mbSend: (_i, draft) => draft && { action: "send", ...draft },
  mbDraft: (i) => native("draft", i),
  mbReply: (i) => native("draft", { body: i.body }), // recipients come from the thread, set by the client
  mbForward: (i) => native("forward", { body: i.body }), // recipients start empty and are set with update_draft
  gmSend: (i) => (i.draftId ? undefined : native("send", i)),
  gmReply: (i) => native("reply", i),
  gmForward: (i) => native("forward", i),
  gmDraft: (i) => native("draft", i),
};

// Pure. The tool's call as one view: send, reply, forward or draft, with bcc and attachments always in it. Undefined for a
// tool that is not a mail tool of the active provider, or a call that cannot be read (a send of a draft nobody read back).
export function mailView(tool: string, input: In, draft?: Omit<MailView, "action">, mail?: MailProvider): MailView | undefined {
  const kind = entryFor(tool, mail)?.view;
  return kind ? VIEWS[kind](input, draft) : undefined;
}
