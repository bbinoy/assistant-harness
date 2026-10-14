import { test } from "node:test";
import assert from "node:assert/strict";
import type { Verdict } from "../src/autojudge.ts";
import { callKey, doneCount, makeCanUseTool, setChatOwnerMessage, setDraftReader } from "../src/permissions.ts";

const SEND = "mcp__mailbird__send_message_now";
// A judge that always says "ask": these tests are about the guard, and must never start a real model process.
const noJudge = async (): Promise<Verdict> => ({ decision: "ask", reason: "test" });

test("an approved call is never asked about or done twice", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], subject: "Re: hi", body: "Hi Jessica" }) as never);
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, undefined, noJudge);
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
  const canUse = makeCanUseTool(async () => ({ approved: answers.shift()! }), "chat", undefined, undefined, noJudge);
  const opts = { signal: new AbortController().signal } as never;
  assert.equal((await canUse(SEND, { messageId: 7 }, opts))!.behavior, "deny");
  assert.equal((await canUse(SEND, { messageId: 7 }, opts))!.behavior, "allow");
});

test("the same guard covers any approved call, not only sends, and an identical auto-judged one", async () => {
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, undefined, noJudge);
  const opts = { signal: new AbortController().signal } as never;
  const call = { summary: "Dinner", startTime: "2026-10-20T19:00:00", attendees: ["a@example.com"] };
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  assert.equal((await canUse(tool, call, opts))!.behavior, "allow");
  assert.equal((await canUse(tool, { ...call }, opts))!.behavior, "deny");
  assert.equal((await canUse(tool, { ...call, startTime: "2026-10-21T19:00:00" }, opts))!.behavior, "allow", "different arguments are a different call");
  assert.equal(asked, 2);
});

test("opening the same page twice is not blocked", async () => {
  const canUse = makeCanUseTool(async () => ({ approved: true }), "chat", undefined, undefined, noJudge);
  const opts = { signal: new AbortController().signal } as never;
  for (let i = 0; i < 2; i++) assert.equal((await canUse("WebFetch", { url: "https://example.com/a", prompt: "x" }, opts))!.behavior, "allow");
});

test("calls that differ only in a nested field are different calls, and key order does not matter", async () => {
  const tool = "mcp__claude_ai_Google_Calendar__create_event";
  const a = { calendarId: "primary", summary: "Dentist", start: { dateTime: "2026-10-15T10:00:00" }, end: { dateTime: "2026-10-15T11:00:00" } };
  const b = { ...a, start: { dateTime: "2026-10-16T14:00:00" }, end: { dateTime: "2026-10-16T15:00:00" } };
  assert.notEqual(callKey(tool, a), callKey(tool, b));
  assert.equal(callKey(tool, a), callKey(tool, { end: a.end, start: { dateTime: "2026-10-15T10:00:00" }, summary: "Dentist", calendarId: "primary" }));
  assert.notEqual(callKey(tool, { attendees: [{ email: "a@example.com" }] }), callKey(tool, { attendees: [{ email: "b@example.com" }] }));
  // and through the guard: the second event is asked about, not refused as "already done"
  let asked = 0;
  const canUse = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, undefined, noJudge);
  const opts = { signal: new AbortController().signal } as never;
  assert.equal((await canUse(tool, a, opts))!.behavior, "allow");
  assert.equal((await canUse(tool, b, opts))!.behavior, "allow");
  assert.equal((await canUse(tool, a, opts))!.behavior, "deny", "the exact repeat is still refused");
  assert.equal(asked, 2);
});

test("remembered calls expire out of the map after the 30 minute window", async () => {
  const canUse = makeCanUseTool(async () => ({ approved: true }), "chat", undefined, undefined, noJudge);
  const opts = { signal: new AbortController().signal } as never;
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    const before = doneCount();
    for (let i = 0; i < 20; i++) await canUse("mcp__claude_ai_Google_Calendar__create_event", { summary: `old ${i}` }, opts);
    assert.equal(doneCount(), before + 20);
    Date.now = () => t0 + 31 * 60_000;
    await canUse("mcp__claude_ai_Google_Calendar__create_event", { summary: "new" }, opts);
    assert.ok(doneCount() <= before + 1, "the old entries were dropped");
  } finally {
    Date.now = realNow;
  }
});

// --- sends are judged in chat, from the owner's words and the exact draft; never unattended ---

test("a chat send is judged against the owner's messages and the draft with bcc; auto skips the question, ask asks", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], bcc: ["spy@example.com"], subject: "Re: hi", body: "Hi Jessica", hasAttachments: true }) as never);
  setChatOwnerMessage("reply to Jessica that Tuesday works");
  setChatOwnerMessage("send it");
  let asked = 0;
  const seen: { description: string; ownerMessage?: string; earlier?: readonly string[] }[] = [];
  const judge = (decision: "auto" | "ask") => async (i: never): Promise<Verdict> => (seen.push(i), { decision, reason: "test" });
  const opts = { signal: new AbortController().signal } as never;
  const auto = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, undefined, judge("auto") as never);
  assert.equal((await auto(SEND, { messageId: 41, confirm: true }, opts))!.behavior, "allow");
  assert.equal(asked, 0, "the judge said auto: no question");
  assert.match(seen[0]!.description, /^✉️ Send email now\nTo: jessica@example\.com\nBcc: spy@example\.com\nSubject: Re: hi\nAttachments: yes/);
  assert.equal(seen[0]!.ownerMessage, "send it");
  assert.deepEqual(seen[0]!.earlier, ["reply to Jessica that Tuesday works"]);
  const askJudge = makeCanUseTool(async () => (asked++, { approved: true }), "chat", undefined, undefined, judge("ask") as never);
  assert.equal((await askJudge(SEND, { messageId: 42, confirm: true }, opts))!.behavior, "allow");
  assert.equal(asked, 1, "the judge said ask: the owner is asked");
});

test("unattended runs never have a send judged, however the judge would answer", async () => {
  setDraftReader(async () => ({ to: ["jessica@example.com"], cc: [], bcc: [], subject: "s", body: "b", hasAttachments: false }) as never);
  const opts = { signal: new AbortController().signal } as never;
  for (const source of ["handler", "brief", "radar", "background"] as const) {
    let judged = 0;
    let asked = 0;
    const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "x" });
    const canUse = makeCanUseTool(async () => (asked++, { approved: false }), source, undefined, "send the reply", judge as never);
    assert.equal((await canUse(SEND, { messageId: 50 + asked, confirm: true }, opts))!.behavior, "deny");
    assert.equal(judged, 0, source);
    assert.equal(asked, 1, `${source} asks the owner`);
  }
});

test("a forward with no recipient yet is never judged; a send whose draft cannot be read is refused", async () => {
  const opts = { signal: new AbortController().signal } as never;
  let judged = 0;
  const judge = async (): Promise<Verdict> => (judged++, { decision: "auto", reason: "x" });
  const canUse = makeCanUseTool(async () => ({ approved: false }), "chat", undefined, undefined, judge as never);
  assert.equal((await canUse("mcp__mailbird__forward_conversation", { conversationId: "g", body: "FYI" }, opts))!.behavior, "allow"); // only saves a draft: no question, nothing to judge
  assert.equal(judged, 0);
  setDraftReader(async () => undefined);
  const r = await canUse(SEND, { messageId: 9, confirm: true }, opts);
  assert.match((r as { message: string }).message, /could not be read back/);
});
