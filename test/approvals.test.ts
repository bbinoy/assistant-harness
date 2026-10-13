import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, answerReaction, request } from "../src/approvals.ts";

// Background approvals (wake-ups, presets, the handler) must not swallow the owner's chat messages.
const call = { tool: "mcp__claude_ai_Google_Calendar__create_event", input: { summary: "x" } };
const ask = (background: boolean, ts = 500) => {
  const asked = request(async () => ts, "Create event x", call, undefined, { background });
  return asked;
};
const settle = () => new Promise((r) => setTimeout(r, 5));

test("background approval: only an explicit yes/no answers it; other messages are chat", async () => {
  const d = ask(true);
  await settle();
  const judged: string[] = [];
  assert.deepEqual(await answer("what is on my calendar tomorrow?", () => judged.push("judge")), { outcome: "none" });
  assert.deepEqual(await answer("yes but later, first tell me the weather", () => judged.push("judge")), { outcome: "none" });
  assert.deepEqual(judged, []); // no judge call, no feedback: the message goes to the chat
  assert.deepEqual(await answer("Yes!", () => {}), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
  const n = ask(true);
  await settle();
  assert.deepEqual(await answer("no", () => {}), { outcome: "declined" });
  assert.deepEqual(await n, { approved: false });
});

test("background approval: a reaction on the approval message still answers it", async () => {
  const d = ask(true, 777);
  await settle();
  assert.equal(answerReaction("👍", 1), "ignored");
  assert.equal(answerReaction("👍", 777), "approved");
  assert.deepEqual(await d, { approved: true });
});

test("chat approval: unchanged, any reply is judged (here: a clear yes needs no judge)", async () => {
  const d = ask(false);
  await settle();
  assert.deepEqual(await answer("ok", () => {}), { outcome: "approved" });
  assert.deepEqual(await d, { approved: true });
});
