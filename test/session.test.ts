import { test } from "node:test";
import assert from "node:assert/strict";
import { planSession, type ChatSession } from "../src/session.ts";

const opts = { idleResetHours: 6, compactTokens: 60_000 };
const now = new Date("2026-10-12T12:00:00Z");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
const session = (s: Partial<ChatSession>): ChatSession => ({ sessionId: "s1", costUsd: 1, ...s });

test("session: no saved session means fresh", () => {
  assert.equal(planSession({ costUsd: 0 }, now, opts), "fresh");
});

test("session: idle boundary is strictly more than the limit", () => {
  assert.equal(planSession(session({ lastTurnAt: ago(5.9) }), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(6) }), now, opts), "resume"); // exactly 6h is not more than 6h
  assert.equal(planSession(session({ lastTurnAt: ago(6.01) }), now, opts), "fresh");
});

test("session: token boundary is strictly more than the limit", () => {
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 60_000 }), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(1), lastContextTokens: 60_001 }), now, opts), "resume then compact");
});

test("session: idle wins over a large context (a fresh session needs no compaction)", () => {
  assert.equal(planSession(session({ lastTurnAt: ago(48), lastContextTokens: 200_000 }), now, opts), "fresh");
});

test("session: old session.json without the new fields still resumes", () => {
  assert.equal(planSession(session({}), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: "garbage" }), now, opts), "resume");
  assert.equal(planSession(session({ lastTurnAt: ago(1) }), now, opts), "resume"); // no token count: nothing to compact
});

test("session: the thresholds come from settings", () => {
  const tight = { idleResetHours: 1, compactTokens: 10_000 };
  assert.equal(planSession(session({ lastTurnAt: ago(2) }), now, tight), "fresh");
  assert.equal(planSession(session({ lastTurnAt: ago(0.5), lastContextTokens: 10_001 }), now, tight), "resume then compact");
});

test("session: a failed compaction backs off for an hour, then tries again", () => {
  const base = { sessionId: "s", costUsd: 1, lastTurnAt: "2026-10-12T10:00:00Z", lastContextTokens: 90_000 };
  const opts = { idleResetHours: 6, compactTokens: 60_000 };
  const failedAt = "2026-10-12T10:05:00Z";
  assert.equal(planSession({ ...base, compactFailedAt: failedAt }, new Date("2026-10-12T10:30:00Z"), opts), "resume");
  assert.equal(planSession({ ...base, compactFailedAt: failedAt }, new Date("2026-10-12T11:06:00Z"), opts), "resume then compact");
  assert.equal(planSession(base, new Date("2026-10-12T10:30:00Z"), opts), "resume then compact");
});
