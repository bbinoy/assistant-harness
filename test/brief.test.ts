import { test } from "node:test";
import assert from "node:assert/strict";
import { clockLine, localDay, shouldRun, type BriefState } from "../src/brief.ts";
import { buildDigest, type TriageEntry } from "../src/digest.ts";
import { chunk } from "../src/outbound.ts";

const opts = { startHour: 7, maxAttempts: 3, paused: false };
const at = (iso: string) => new Date(iso); // local time, no zone suffix

test("brief: does not run before the start hour", () => {
  assert.equal(shouldRun({ attempts: 0 }, at("2026-10-12T06:59:00"), opts).run, false);
});

test("brief: runs on the first tick at or after the start hour", () => {
  assert.equal(shouldRun({ attempts: 0 }, at("2026-10-12T07:00:00"), opts).run, true);
});

test("brief: runs late too, with no cutoff (Mac woke at 15:30)", () => {
  assert.equal(shouldRun({ attempts: 0 }, at("2026-10-12T15:30:00"), opts).run, true);
  assert.equal(shouldRun({ attempts: 0 }, at("2026-10-12T23:50:00"), opts).run, true);
});

test("brief: only once per day", () => {
  const s: BriefState = { attempts: 1, doneDay: "2026-10-12", attemptDay: "2026-10-12" };
  assert.equal(shouldRun(s, at("2026-10-12T09:00:00"), opts).run, false);
  assert.equal(shouldRun(s, at("2026-10-13T07:15:00"), opts).run, true); // next day is fresh
});

test("brief: retries a failed run, up to the cap", () => {
  const failed = (n: number): BriefState => ({ attempts: n, attemptDay: "2026-10-12" });
  assert.equal(shouldRun(failed(1), at("2026-10-12T08:00:00"), opts).run, true);
  assert.equal(shouldRun(failed(2), at("2026-10-12T08:15:00"), opts).run, true);
  const capped = shouldRun(failed(3), at("2026-10-12T08:30:00"), opts);
  assert.equal(capped.run, false);
  assert.equal(capped.reason, "attempt cap reached");
});

test("brief: attempts from yesterday do not count today", () => {
  assert.equal(shouldRun({ attempts: 3, attemptDay: "2026-10-11" }, at("2026-10-12T07:05:00"), opts).run, true);
});

test("brief: pause switch wins over everything", () => {
  assert.equal(shouldRun({ attempts: 0 }, at("2026-10-12T09:00:00"), { ...opts, paused: true }).run, false);
});

test("clock line: exact weekday and date pairs", () => {
  const line = clockLine(at("2026-10-11T09:30:00"));
  assert.match(line, /it is now Sunday 2026-10-11 09:30/);
  assert.match(line, /Yesterday was Saturday 2026-10-10/);
  assert.match(line, /Tomorrow is Monday 2026-10-12/);
  assert.match(line, /day after is Tuesday 2026-10-13/);
});

test("clock line: month and year rollover", () => {
  const line = clockLine(at("2026-12-31T08:00:00"));
  assert.match(line, /Tomorrow is Friday 2027-01-01/);
  assert.equal(localDay(at("2026-01-05T00:00:00")), "2026-01-05");
});

const entry = (label: string, from: string, subject: string, kind = "personal_or_work", decision = `would-${label}`): TriageEntry => ({
  ts: "2026-10-12T05:00:00Z",
  decision,
  meta: { label, from, subject, kind, messageId: 7 },
});

test("digest: empty", () => {
  assert.match(buildDigest([], undefined), /Nothing new arrived/);
});

test("digest: says plainly when the heartbeat only logged", () => {
  const d = buildDigest([entry("archive", "Climate Weekly", "5 funding rounds", "newsletter")], "2026-10-11T08:00:00Z");
  assert.match(d, /LOG-ONLY/);
  assert.match(d, /Climate Weekly: 5 funding rounds \[newsletter\] \{msg 7\}/);
});

test("digest: no log-only warning once it really acts", () => {
  const d = buildDigest([entry("archive", "X", "Y", "newsletter", "archived")], undefined);
  assert.doesNotMatch(d, /LOG-ONLY/);
});

test("digest: caps very long lists", () => {
  const many = Array.from({ length: 55 }, (_, i) => entry("archive", `S${i}`, "n", "notification"));
  assert.match(buildDigest(many, undefined), /\.\.\.and 15 more/);
});

test("chunk: splits on paragraphs and respects the limit", () => {
  const text = ("para ".repeat(60) + "\n\n").repeat(5);
  const parts = chunk(text, 500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 500));
  assert.equal(parts.join(" ").replace(/\s+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
});
