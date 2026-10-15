import test from "node:test";
import assert from "node:assert/strict";
import { describeCall } from "../src/format.ts";
import { composeQuestion } from "../src/approvalmodel.ts";
import { templateQuestion } from "../src/questiontemplate.ts";

const cal = { eventId: "evt_8f2a", summary: "Dentist", startTime: "2026-10-20T16:00:00", endTime: "2026-10-20T17:00:00", timeZone: "Europe/Berlin" };
const tool = "mcp__claude_ai_Google_Calendar__update_event";
const details = describeCall(tool, cal);

test("a simple call is asked from the code template: no model call, same fact check", async () => {
  const prompts: string[] = [];
  const run = async (p: string) => (prompts.push(p), undefined);
  const c = await composeQuestion({ tool, args: cal, details, recent: [], background: false, source: "chat" }, {}, 1000, run);
  assert.equal(c.by, "template");
  assert.equal(prompts.length, 0);
  assert.match(c.text!, /Dentist/);
  assert.match(c.text!, /16:00–17:00/);
  assert.match(c.text!, /Go ahead\?$/);
  assert.match(templateQuestion({ tool, args: cal, details, background: true })!, /^A background task asks to:/);
});

test("long, cut, untitled or incomplete details are left to the model", async () => {
  assert.equal(templateQuestion({ tool: "mcp__x__do", args: { a: 1 }, details: describeCall("mcp__x__do", { a: 1 }), background: false }), undefined);
  assert.equal(templateQuestion({ tool, args: cal, details: `${details}\n${"x".repeat(700)}`, background: false }), undefined);
  assert.equal(templateQuestion({ tool, args: cal, details: `${details}\n(+5 more characters not shown)`, background: false }), undefined);
  assert.equal(templateQuestion({ tool, args: cal, details: "📅 Change calendar event\n“Dentist”", background: false }), undefined);
  // the model path is used for them, with its own failure behaviour
  const c = await composeQuestion({ tool, args: cal, details: `${details}\n${"x".repeat(700)}`, recent: [], background: false, source: "chat" }, {}, 1000, async () => undefined);
  assert.equal(c.text, undefined);
});
