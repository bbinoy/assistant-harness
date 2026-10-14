import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { overBudget, recordCost, spentToday } from "../src/budget.ts";
import { loadSettings, settings } from "../src/settings.ts";
import { appendLine, dataPath, readJson, readText, secureDataDirs, writeJson, writeText } from "../src/state.ts";
import { migrateLegacyLayout, newPlaceOf } from "../src/migrate.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("tests run against a throwaway data directory, never the real one", () => {
  assert.ok(process.env.HARNESS_DATA_DIR, "npm test sets HARNESS_DATA_DIR");
  assert.equal(settings.dataDir, resolve(process.env.HARNESS_DATA_DIR!));
  assert.ok(!existsSync(join(settings.dataDir, "src")), "the data root is not the repo");
});

test("settings: three folders under HARNESS_DATA_DIR, default is the repo root", () => {
  const s = loadSettings({ HARNESS_DATA_DIR: "/tmp/x-data" });
  assert.deepEqual([s.dataDir, s.stateDir, s.logsDir, s.memoryDir], ["/tmp/x-data", "/tmp/x-data/state", "/tmp/x-data/logs", "/tmp/x-data/memory"]);
  const d = loadSettings({});
  assert.ok(!d.dataDir.endsWith("/src") && d.stateDir === join(d.dataDir, "state"));
  assert.ok(existsSync(join(d.dataDir, "src")), "default data root is the parent of src/");
});

test("settings: chat session rules are validated", () => {
  const d = loadSettings({});
  assert.deepEqual([d.chatIdleResetHours, d.chatCompactTokens], [72, 150_000]);
  assert.throws(() => loadSettings({ CHAT_IDLE_RESET_HOURS: "0" }), /CHAT_IDLE_RESET_HOURS/);
  assert.throws(() => loadSettings({ CHAT_IDLE_RESET_HOURS: "169" }), /CHAT_IDLE_RESET_HOURS/);
  assert.throws(() => loadSettings({ CHAT_COMPACT_TOKENS: "9999" }), /CHAT_COMPACT_TOKENS/);
  assert.throws(() => loadSettings({ CHAT_COMPACT_TOKENS: "500001" }), /CHAT_COMPACT_TOKENS/);
  assert.equal(loadSettings({ CHAT_COMPACT_TOKENS: "10000" }).chatCompactTokens, 10_000);
});

test("state: JSON round-trips, owner-only, no temp files left behind", () => {
  writeJson("state/t.json", { a: 1 });
  assert.deepEqual(readJson("state/t.json", null), { a: 1 });
  assert.equal(statSync(dataPath("state/t.json")).mode & 0o777, 0o600);
  assert.equal(readdirSync(settings.stateDir).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("state: all three folders are 700 and their files 600; paths outside them are refused", () => {
  writeText("logs/t.log", "x");
  appendLine("logs/t.log", "y");
  writeText("memory/t.md", "x");
  chmodSync(dataPath("memory/t.md"), 0o644);
  secureDataDirs();
  for (const d of [settings.stateDir, settings.logsDir, settings.memoryDir]) assert.equal(statSync(d).mode & 0o777, 0o700, d);
  assert.equal(statSync(dataPath("memory/t.md")).mode & 0o777, 0o600);
  assert.equal(readText("logs/t.log"), "xy\n");
  // a group's session pointer lives in its own folder: an absolute path is fine inside the data root, never outside
  writeJson(join(settings.memoryDir, "groups", "k", "session.json"), { a: 1 });
  assert.deepEqual(readJson(join(settings.memoryDir, "groups", "k", "session.json"), {}), { a: 1 });
  assert.throws(() => dataPath(join(settings.dataDir, "..", "elsewhere.json")), /not a path/);
  assert.throws(() => dataPath("/etc/passwd"), /not a path/);
  for (const bad of ["seen.json", "other/x.json", "state/../x", "state/.hidden", "state/a/b"]) assert.throws(() => dataPath(bad), /not a path/, bad);
});

test("state: a missing or corrupt file falls back to the default", () => {
  assert.deepEqual(readJson("state/missing.json", { d: true }), { d: true });
  writeText("state/bad.json", "{not json");
  assert.deepEqual(readJson("state/bad.json", { d: true }), { d: true });
});

test("migration: the mapping sends logs to logs/, the last brief to memory/, the rest stays", () => {
  for (const n of ["agent.log", "agent.log.1", "agent.log.3", "audit.jsonl", "audit.jsonl.1", "signal-daemon.log", "launchd-stderr.log"]) assert.equal(newPlaceOf(n), `logs/${n}`, n);
  assert.equal(newPlaceOf("last-brief.md"), "memory/last-brief.md");
  for (const n of ["seen.json", "brief.json", "handle-queue.json", "cost.json", "heartbeat.json", "session.json", "paused", "agent.log.bak", "audit.jsonl.tmp"]) assert.equal(newPlaceOf(n), undefined, n);
});

test("migration: moves old files once, never overwrites, is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-migrate-"));
  mkdirSync(join(root, "state"));
  const put = (rel: string, text: string) => writeFileSync(join(root, rel), text);
  put("state/agent.log", "log");
  put("state/audit.jsonl", "old audit");
  put("state/last-brief.md", "brief");
  put("state/seen.json", "{}");
  mkdirSync(join(root, "logs"));
  put("logs/audit.jsonl", "already migrated"); // present at the new place: the old one is left alone
  assert.deepEqual(migrateLegacyLayout(root).sort(), ["logs/agent.log", "memory/last-brief.md"]);
  assert.equal(readFileSync(join(root, "logs/agent.log"), "utf8"), "log");
  assert.equal(readFileSync(join(root, "memory/last-brief.md"), "utf8"), "brief");
  assert.equal(readFileSync(join(root, "logs/audit.jsonl"), "utf8"), "already migrated");
  assert.ok(existsSync(join(root, "state/audit.jsonl")) && existsSync(join(root, "state/seen.json")));
  assert.deepEqual(migrateLegacyLayout(root), []); // second run: nothing to do
  assert.deepEqual(migrateLegacyLayout(join(root, "nowhere")), []); // fresh install
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

test("settings: the tool-hiding lists have safe defaults and reject typos", () => {
  const d = loadSettings({});
  assert.ok(d.hiddenConnectors.includes("mcp__claude_ai_Interactive_Brokers_IBKR"));
  assert.deepEqual(d.notionTools, ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"]);
  assert.deepEqual(loadSettings({ NOTION_TOOLS: "notion-fetch, notion-search" }).notionTools, ["notion-fetch", "notion-search"]);
  assert.ok(d.mailbirdTools.includes("get_message") && !d.mailbirdTools.includes("snooze_conversation"));
  assert.throws(() => loadSettings({ MAILBIRD_TOOLS: "Get-Message" }), /MAILBIRD_TOOLS/);
  assert.throws(() => loadSettings({ NOTION_TOOLS: "fetch" }), /NOTION_TOOLS/);
  assert.throws(() => loadSettings({ HIDDEN_CONNECTORS: "Gmail" }), /HIDDEN_CONNECTORS/);
});
