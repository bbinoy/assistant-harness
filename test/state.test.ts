import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { overBudget, recordCost, spentToday } from "../src/budget.ts";
import { loadSettings, settings } from "../src/settings.ts";
import { readJson, statePath, writeJson } from "../src/state.ts";

test("tests run against a throwaway state directory, never the real one", () => {
  assert.ok(process.env.HARNESS_STATE_DIR, "npm test sets HARNESS_STATE_DIR");
  assert.ok(!settings.stateDir.endsWith("/harness/state"));
});

test("state: JSON round-trips, owner-only, no temp files left behind", () => {
  writeJson("t.json", { a: 1 });
  assert.deepEqual(readJson("t.json", null), { a: 1 });
  assert.equal(statSync(statePath("t.json")).mode & 0o777, 0o600);
  assert.equal(readdirSync(settings.stateDir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("state: a missing or corrupt file falls back to the default", () => {
  assert.deepEqual(readJson("missing.json", { d: true }), { d: true });
  writeFileSync(statePath("bad.json"), "{not json");
  assert.deepEqual(readJson("bad.json", { d: true }), { d: true });
});

test("budget: costs accumulate and the over-budget notice fires once", () => {
  const start = spentToday();
  recordCost(1.25);
  recordCost(0.75);
  recordCost(-5); // ignored
  assert.equal(spentToday(), start + 2);
  recordCost(settings.dailyBudgetUsd);
  assert.deepEqual([overBudget().over, overBudget().firstTime], [true, false]); // first call consumed the notice
});

test("settings: defaults, and typos fail loudly instead of becoming NaN", () => {
  const d = loadSettings({});
  assert.equal(d.heartbeatMinutes, 15);
  assert.equal(d.heartbeatLive, true);
  assert.equal(d.signalHost, "127.0.0.1");
  assert.throws(() => loadSettings({ HEARTBEAT_MINUTES: "abc" }), /HEARTBEAT_MINUTES/);
  assert.throws(() => loadSettings({ HEARTBEAT_MINUTES: "0" }), /HEARTBEAT_MINUTES/);
  assert.throws(() => loadSettings({ QUIET_START_HOUR: "24" }), /QUIET_START_HOUR/);
  assert.throws(() => loadSettings({ HEARTBEAT_ACTIONS: "yes" }), /HEARTBEAT_ACTIONS/);
  assert.equal(loadSettings({ HEARTBEAT_ACTIONS: "log" }).heartbeatLive, false);
});
