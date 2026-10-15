import { test } from "node:test";
import assert from "node:assert/strict";
import { answer, answerReaction, formatWait, request } from "../src/approvals.ts";
import { settings } from "../src/settings.ts";

(settings as { approvalStyle: string }).approvalStyle = "strict"; // these tests are the strict flow; the default is conversational (test/softapproval.test.ts)

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

// ---- several open approvals ----
const sent: string[] = [];
const askTs = (background: boolean, ts: number, desc = `Create event ${ts}`, signal?: AbortSignal) =>
  request(async (t) => (sent.push(t), ts), desc, call, signal, { background });

test("three chat approvals: answered independently by reaction, quoted reply, and plain no (newest)", async () => {
  const a = askTs(false, 1001);
  const b = askTs(false, 1002);
  const c = askTs(false, 1003);
  await settle();
  assert.equal(answerReaction("👎", 1001), "declined");
  assert.deepEqual(await a, { approved: false });
  assert.deepEqual(await answer("yes", () => {}, { timestamp: 1002 }), { outcome: "approved" }); // quoted: b, not the newest c
  assert.deepEqual(await b, { approved: true });
  assert.deepEqual(await answer("no", () => {}), { outcome: "declined" }); // plain: newest remaining = c
  assert.deepEqual(await c, { approved: false });
  assert.deepEqual(await answer("yes", () => {}), { outcome: "none" });
});

test("plain yes goes to the newest chat approval, leaving the older one open", async () => {
  const a = askTs(false, 1101);
  const b = askTs(false, 1102);
  await settle();
  assert.deepEqual(await answer("yes", () => {}), { outcome: "approved" });
  assert.deepEqual(await b, { approved: true });
  assert.equal(answerReaction("👍", 1101), "approved");
  assert.deepEqual(await a, { approved: true });
});

test("a background approval does not block a later chat approval; a plain yes prefers the chat one", async () => {
  const bg = askTs(true, 1201);
  const chat = askTs(false, 1202);
  await settle();
  assert.deepEqual(await answer("yes", () => {}), { outcome: "approved" });
  assert.deepEqual(await chat, { approved: true });
  assert.deepEqual(await answer("no", () => {}), { outcome: "declined" }); // the only open one is now the background one
  assert.deepEqual(await bg, { approved: false });
});

test("two background approvals: a plain yes is a normal message; a reaction still answers", async () => {
  const a = askTs(true, 1301);
  const b = askTs(true, 1302);
  await settle();
  assert.deepEqual(await answer("yes", () => {}), { outcome: "none" });
  assert.equal(answerReaction("👍", 1301), "approved");
  assert.deepEqual(await a, { approved: true });
  assert.deepEqual(await answer("no", () => {}), { outcome: "declined" }); // exactly one left
  assert.deepEqual(await b, { approved: false });
});

test("timeouts per kind and the stated wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  sent.length = 0;
  let chatDone = false;
  let bgDone = false;
  const chat = askTs(false, 1401).then((d) => ((chatDone = true), d));
  const bg = askTs(true, 1402).then((d) => ((bgDone = true), d));
  assert.match(sent[0]!, /\(15 min, then I assume no\)/);
  assert.match(sent[1]!, /\(2 h, then I assume no\)/);
  t.mock.timers.tick(15 * 60_000 - 1);
  await Promise.resolve();
  assert.equal(chatDone, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await chat, { approved: false });
  assert.equal(bgDone, false);
  assert.equal(answerReaction("👍", 1401), "ignored"); // expired
  t.mock.timers.tick(105 * 60_000 - 1);
  await Promise.resolve();
  assert.equal(bgDone, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await bg, { approved: false });
  assert.equal(sent.length, 2); // nothing extra sent on expiry
});

test("aborting a chat turn declines only its own approval", async () => {
  const ac = new AbortController();
  const a = askTs(false, 1501, "x", ac.signal);
  const b = askTs(false, 1502);
  await settle();
  ac.abort();
  assert.deepEqual(await a, { approved: false });
  assert.equal(answerReaction("👍", 1502), "approved");
  assert.deepEqual(await b, { approved: true });
});

test("formatWait", () => {
  assert.equal(formatWait(15), "15 min");
  assert.equal(formatWait(120), "2 h");
  assert.equal(formatWait(90), "1 h 30 min");
});
