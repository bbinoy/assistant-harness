import { readJson, writeJson } from "./state.ts";

// Tool names runs have seen, so policy.hiddenTools() can hide the unused ones by name.
// Seeded with Notion's and Mailbird's current tools, so even the very first run is trimmed.
const TOOLS_SEEN = "state/tools-seen.json";
const NOTION_NAMES = "ai-search check-mcp-next-steps convert-page-to-skill create-attachment create-comment create-database create-file-upload create-folder create-view download-attachment download-skill duplicate-page get-async-task get-comments get-session-status get-teams get-tool-access get-users list-favorite-pages list-private-pages list-recent-pages list-session-events list-shared-pages move-pages query-data-sources query-meeting-notes query-multiple-data-sources query-sessions read-session-event search-agents search-sessions send-message-to-session show-advanced-analysis-next-steps spawn-session stop-session update-data-source update-folder update-view upload-skill wait-session"
  .split(" ")
  .map((t) => `mcp__claude_ai_Notion__notion-${t}`);
const MAILBIRD_NAMES = "archive_conversation copy_conversation create_draft delete_conversation_permanently discard_draft forward_conversation get_attachment_content get_conversation get_help get_message get_send_status get_ui_state list_accounts list_attachments list_conversations list_folders mark_all_as_read move_conversation move_conversation_to_inbox reply_all_to_conversation reply_to_conversation search_conversations select_conversation send_message_now send_self_briefing set_conversation_important set_conversation_read set_conversation_spam set_conversation_starred set_sender_blocked show_notification snooze_conversation summarize_all_inboxes trash_conversation unsubscribe_from_newsletter update_draft"
  .split(" ")
  .map((t) => `mcp__mailbird__${t}`);
const GMAIL_NAMES = "apply_sensitive_message_label apply_sensitive_thread_label create_draft create_label delete_draft delete_label forward get_draft get_message get_thread label_message label_thread list_drafts list_labels mark_message_spam mark_thread_spam reply search_threads send_message trash_message trash_thread unlabel_message unlabel_thread unmark_message_spam unmark_thread_spam untrash_message untrash_thread update_draft update_label update_message_labels"
  .split(" ")
  .map((t) => `mcp__claude_ai_Gmail__${t}`);
const SEED = [...NOTION_NAMES, ...MAILBIRD_NAMES, ...GMAIL_NAMES];
export const toolsSeen = () => readJson<string[]>(TOOLS_SEEN, SEED);
export function recordToolsSeen(tools: readonly string[]) {
  const known = toolsSeen();
  const added = tools.filter((t) => t.startsWith("mcp__") && !known.includes(t));
  if (added.length) writeJson(TOOLS_SEEN, [...known, ...added]);
}
