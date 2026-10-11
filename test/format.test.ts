import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCall } from "../src/format.ts";

test("approval text: a long email body is shown generously and the cut is announced", () => {
  const body = "Hello. ".repeat(300); // 2100 chars
  const text = describeCall("mcp__mailbird__send_message_now", { to: "x@example.com", subject: "Hi", body });
  assert.match(text, /^✉️ Send email now/);
  assert.match(text, /more characters not shown\)/);
  assert.ok(text.length > 1200);
});

test("approval text: nothing is cut silently", () => {
  const text = describeCall("mcp__x__do", { note: "y".repeat(500) });
  assert.match(text, /\(\+300 more characters not shown\)/);
});

test("approval text: people shown as addresses, any other object shown in full", () => {
  const text = describeCall("mcp__claude_ai_Google_Calendar__create_event", {
    summary: "Sync",
    startTime: "2026-10-14T15:00:00",
    endTime: "2026-10-14T16:00:00",
    attendees: [{ email: "a@example.com", responseStatus: "needsAction" }],
    extra: { email: "b@example.com", webhook: "https://example.com/hook" },
  });
  assert.match(text, /With: a@example\.com/);
  assert.match(text, /webhook/); // not hidden behind its email field
  assert.match(text, /🕒 Wed 14 Oct, 15:00–16:00/);
});

test("approval text: text-direction controls are stripped, so what shows is what runs", () => {
  const text = describeCall("mcp__mailbird__send_message_now", { to: "x@example.com", body: "archive ‮ecnab‬ mail" });
  assert.doesNotMatch(text, /[‪-‮⁦-⁩]/);
  assert.match(text, /archive ecnab mail/);
});
