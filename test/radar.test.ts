import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptMessages, MAX_PER_RUN, MAX_TEXT } from "../src/radar-rules.ts";

const NOW = new Date("2026-10-12T10:00:00");
const emptyState = () => ({ sent: 0, keys: {} as Record<string, number> });
const msg = (key: string, text = "Prep for the call at 11:00", kind = "prep") => ({ kind, key, text });

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
