import { test } from "node:test";
import assert from "node:assert/strict";
import { idsOf } from "../src/agent.ts";
import { applyChanges, classify, isReadTool } from "../src/policy.ts";

const N = "mcp__claude_ai_Notion__";
const M = "mcp__mailbird__";
const C = "mcp__claude_ai_Google_Calendar__";
const chat = (tool: string, input: Record<string, unknown> = {}) => classify(tool, input, "chat");

test("reads are allowed, including Notion's prefixed names (regression: brief hung on approval)", () => {
  for (const t of [
    `${N}notion-fetch`, `${N}notion-search`, `${N}notion-ai-search`, `${N}notion-query-meeting-notes`,
    `${N}notion-get-comments`, `${N}notion-list-recent-pages`,
    `${M}get_message`, `${M}list_conversations`, `${M}summarize_all_inboxes`, `${M}search_conversations`,
    `${C}list_events`, `${C}get_event`, `${C}suggest_time`,
    "mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Google_Drive__read_file_content",
  ]) assert.equal(chat(t), "allow", t);
});

test("routine writes run unattended for chat and the brief", () => {
  for (const t of [`${M}archive_conversation`, `${M}create_draft`, `${M}reply_to_conversation`, `${M}send_self_briefing`, `${N}notion-create-pages`, `${N}notion-update-page`]) {
    assert.equal(classify(t, {}, "chat"), "allow", t);
    assert.equal(classify(t, {}, "brief"), "allow", t);
  }
});

test("the mail handler (reads untrusted mail, nobody watching) may only leave reply drafts", () => {
  assert.equal(classify(`${M}reply_to_conversation`, {}, "handler"), "allow");
  assert.equal(classify(`${M}get_message`, {}, "handler"), "allow");
  for (const t of [`${M}create_draft`, `${M}update_draft`, `${M}archive_conversation`, `${N}notion-update-page`, `${M}send_self_briefing`])
    assert.equal(classify(t, {}, "handler"), "ask", t);
});

test("nothing may reference local files (create_draft takes file:// attachments)", () => {
  assert.equal(chat(`${M}create_draft`, { to: "x@example.com", attachments: ["file:///home/someone/.ssh/id_ed25519"] }), "deny");
  assert.equal(chat(`${M}create_draft`, { to: "x@example.com", attachments: ["FILE://~/.env"] }), "deny");
  assert.equal(chat(`${M}create_draft`, { to: "x@example.com", attachments: ["mailbird://mcp/messages/1/attachments/2"] }), "allow");
});

test("outward-facing actions ask", () => {
  for (const t of [`${M}send_message_now`, `${M}forward_conversation`, `${C}create_event`, `${C}update_event`, `${C}respond_to_event`, "mcp__claude_ai_Google_Drive__share_file", "mcp__claude_ai_Gmail__send_message", `${N}notion-create-comment`])
    assert.equal(chat(t), "ask", t);
});

test("destructive actions and trading are denied, for everyone", () => {
  for (const t of [`${M}trash_conversation`, `${M}delete_conversation_permanently`, `${C}delete_event`, "mcp__claude_ai_Gmail__trash_thread", `${M}set_sender_blocked`, "mcp__claude_ai_Interactive_Brokers_IBKR__create_order_instruction", "mcp__claude_ai_Interactive_Brokers_IBKR__get_account_balances"])
    for (const source of ["chat", "brief", "handler"] as const) assert.equal(classify(t, {}, source), "deny", `${t} (${source})`);
});

test("unknown tools default to ask, never allow", () => {
  assert.equal(chat("mcp__new_server__do_something"), "ask");
  assert.equal(chat("Bash"), "ask");
});

test("a verb in the middle of a name is not a read", () => {
  assert.equal(isReadTool("mcp__x__update_get_thing"), false);
  assert.equal(isReadTool("mcp__x__send_search"), false);
});

test("edit-and-approve: allowed fields only, calendar only", () => {
  const input = { summary: "t", startTime: "2026-10-12T15:00:00", endTime: "2026-10-12T16:00:00", attendees: ["a@example.com"] };
  const tool = `${C}create_event`;
  assert.deepEqual(applyChanges(tool, input, [{ field: "startTime", value: "2026-10-12T16:00:00" }])?.startTime, "2026-10-12T16:00:00");
  assert.equal(applyChanges(tool, input, [{ field: "attendees", value: "x" }]), undefined); // protected
  assert.equal(applyChanges(tool, input, [{ field: "newField", value: "x" }]), undefined); // no new fields
  assert.equal(applyChanges(`${M}send_message_now`, { to: "a" }, [{ field: "to", value: "b" }]), undefined); // not modifiable
  assert.equal(applyChanges(tool, input, []), undefined);
});

test("memory tools: recall is a read, changes ask in chat and are denied for everyone else", () => {
  const MEM = "mcp__memory__";
  for (const source of ["chat", "brief", "handler", "heartbeat"] as const) assert.equal(classify(`${MEM}recall`, {}, source), "allow", source);
  for (const t of [`${MEM}remember`, `${MEM}forget`]) {
    assert.equal(classify(t, { category: "Style", text: "x" }, "chat"), "ask", t);
    for (const source of ["brief", "handler", "heartbeat"] as const) assert.equal(classify(t, {}, source), "deny", `${t} (${source})`);
  }
  assert.equal(classify(`${MEM}remember`, { text: "see file:///etc/passwd" }, "chat"), "deny"); // the file:// rule still applies
});

test("audit ids: keeps ids, drops content", () => {
  assert.deepEqual(idsOf({ conversationId: "abc", body: "secret text", subject: "x" }), { ids: { conversationId: "abc" } });
  assert.deepEqual(idsOf({ messageId: 5, id: "x" }), { ids: { messageId: 5, id: "x" } });
  assert.equal(idsOf({ body: "only content" }), undefined);
});
