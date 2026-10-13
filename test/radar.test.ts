import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptMessages, emptyState, isDue, MAX_PER_RUN, MAX_TEXT, rollover } from "../src/radar-rules.ts";

const NOW = new Date("2026-10-12T10:00:00");
const msg = (key: string, text = "Prep for the call at 11:00", kind = "prep") => ({ kind, key, text });

test("radar: due on first run, and again once the interval has passed", () => {
  assert.equal(isDue(emptyState(), NOW, 120), true);
  assert.equal(isDue({ ...emptyState(), lastRunAt: "2026-10-12T08:30:00" }, NOW, 120), false); // 90 min ago
  assert.equal(isDue({ ...emptyState(), lastRunAt: "2026-10-12T08:00:00" }, NOW, 120), true); // exactly 120
  assert.equal(isDue({ ...emptyState(), lastRunAt: "garbage" }, NOW, 120), true);
});

test("radar: well-formed new messages pass; repeats, junk and oversized text are handled", () => {
  const out = acceptMessages({ messages: [msg("prep:a@1"), msg("prep:a@1"), msg("", "x"), { kind: "spam", key: "k", text: "t" }, msg("k2", "  "), msg("clash:x", "y".repeat(5000), "clash"), "nonsense", null] }, emptyState(), 8);
  assert.deepEqual(out.map((m) => m.key), ["prep:a@1", "clash:x"]);
  assert.equal(out[1]!.text.length, MAX_TEXT);
  assert.deepEqual(acceptMessages(undefined, emptyState(), 8), []);
  assert.deepEqual(acceptMessages({ messages: "x" }, emptyState(), 8), []);
});

test("radar: something already sent is never sent again", () => {
  const state = { ...emptyState(), keys: { "prep:a@1": NOW.getTime() } };
  assert.deepEqual(acceptMessages({ messages: [msg("prep:a@1"), msg("prep:b@2")] }, state, 8).map((m) => m.key), ["prep:b@2"]);
});

test("radar: at most three per run, and never past the daily cap", () => {
  const many = { messages: Array.from({ length: 10 }, (_, i) => msg(`k${i}`)) };
  assert.equal(acceptMessages(many, emptyState(), 8).length, MAX_PER_RUN);
  assert.equal(acceptMessages(many, { ...emptyState(), sent: 7 }, 8).length, 1);
  assert.equal(acceptMessages(many, { ...emptyState(), sent: 8 }, 8).length, 0);
  assert.equal(acceptMessages(many, emptyState(), 0).length, 0);
});

test("radar: a new day resets the counter, old keys expire", () => {
  const old = NOW.getTime() - 4 * 24 * 3600_000;
  const s = rollover({ day: "2026-10-11", sent: 5, keys: { old: old, recent: NOW.getTime() - 1000 } }, "2026-10-12", NOW);
  assert.equal(s.sent, 0);
  assert.deepEqual(Object.keys(s.keys), ["recent"]);
  assert.equal(rollover({ day: "2026-10-12", sent: 5, keys: {} }, "2026-10-12", NOW).sent, 5);
});

test("radar: the next run is set shortly before the next meeting, within bounds", async () => {
  const { scheduleNext, nudge, isDue } = await import("../src/radar-rules.ts");
  const now = new Date("2026-10-13T10:00:00Z");
  const mins = (iso: string) => (Date.parse(iso) - now.getTime()) / 60_000;
  assert.equal(mins(scheduleNext(now, 240, 180)), 180); // far away: capped at the longest wait
  assert.equal(mins(scheduleNext(now, 120, 180)), 60); // an hour before the meeting
  assert.equal(mins(scheduleNext(now, 70, 180)), 45); // never sooner than 45 minutes
  assert.equal(mins(scheduleNext(now, null, 180)), 180); // unknown: the longest wait
  assert.equal(mins(scheduleNext(now, "soon", 180)), 180);
  const s = { sent: 0, keys: {}, lastRunAt: "2026-10-13T09:50:00Z", nextRunAt: "2026-10-13T13:00:00Z" };
  assert.equal(nudge(s, now).nextRunAt, "2026-10-13T10:20:00.000Z"); // 30 minutes after the last run
  assert.equal(isDue(nudge(s, now), new Date("2026-10-13T10:21:00Z"), 180), true);
  assert.equal(isDue(s, new Date("2026-10-13T12:59:00Z"), 180), false);
  const sooner = { ...s, nextRunAt: "2026-10-13T10:05:00Z" };
  assert.equal(nudge(sooner, now).nextRunAt, "2026-10-13T10:05:00.000Z"); // never pushes a run later
});
