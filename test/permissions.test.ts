import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCanUseTool, setDraftReader } from "../src/permissions.ts";

const SEND = "mcp__mailbird__send_message_now";

test("an approved call is never asked about or done twice", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], subject: "Re: hi", body: "Hi Jessica" }) as never);
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined);
  const opts = { signal: new AbortController().signal } as never;
  const first = await canUse(SEND, { messageId: 26001, confirm: true }, opts);
  assert.equal(first!.behavior, "allow");
  const again = await canUse(SEND, { messageId: 26001, confirm: true }, opts);
  assert.equal(again!.behavior, "deny");
  assert.match((again! as { message: string }).message, /already approved and done/);
  assert.equal(asked, 1, "the owner is asked once");
  // another draft is a different send
  assert.equal((await canUse(SEND, { messageId: 26002, confirm: true }, opts))!.behavior, "allow");
  assert.equal(asked, 2);
});

test("a declined send can be asked again", async () => {
  setDraftReader(async () => ({ to: ["a@example.com"], cc: [], subject: "s", body: "b" }) as never);
  let answers = [false, true];
  const canUse = makeCanUseTool(async () => ({ approved: answers.shift()! }), "chat", undefined);
  const opts = { signal: new AbortController().signal } as never;
  assert.equal((await canUse(SEND, { messageId: 7 }, opts))!.behavior, "deny");
  assert.equal((await canUse(SEND, { messageId: 7 }, opts))!.behavior, "allow");
});

test("the same guard covers any approved call, not only sends, and an identical auto-judged one", async () => {
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined);
  const opts = { signal: new AbortController().signal } as never;
  const call = { summary: "Dinner", startTime: "2026-10-20T19:00:00", attendees: ["a@example.com"] };
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  assert.equal((await canUse(tool, call, opts))!.behavior, "allow");
  assert.equal((await canUse(tool, { ...call }, opts))!.behavior, "deny");
  assert.equal((await canUse(tool, { ...call, startTime: "2026-10-21T19:00:00" }, opts))!.behavior, "allow", "different arguments are a different call");
  assert.equal(asked, 2);
});

test("opening the same page twice is not blocked", async () => {
  const canUse = makeCanUseTool(async () => ({ approved: true }), "chat", undefined);
  const opts = { signal: new AbortController().signal } as never;
  for (let i = 0; i < 2; i++) assert.equal((await canUse("WebFetch", { url: "https://example.com/a", prompt: "x" }, opts))!.behavior, "allow");
});
