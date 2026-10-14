import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../src/settings.ts";

test("settings: Kokoro is the default speech provider, with no fallback", () => {
  const s = loadSettings({});
  assert.equal(s.tts.provider, "kokoro");
  assert.equal(s.tts.fallback, "none");
});

test("settings: remote speech needs its keys and a safe address, or the agent does not start", () => {
  assert.throws(() => loadSettings({ TTS_PROVIDER: "elevenlabs" }), /ELEVENLABS_API_KEY/);
  assert.throws(() => loadSettings({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" }), /ELEVENLABS_VOICE_ID/);
  const e = loadSettings({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", TTS_FALLBACK: "kokoro" }).tts;
  assert.ok(e.provider === "elevenlabs" && e.elevenlabs.modelId === "eleven_multilingual_v2" && e.fallback === "kokoro");
  assert.throws(() => loadSettings({ TTS_PROVIDER: "http" }), /TTS_HTTP_URL/);
  assert.throws(() => loadSettings({ TTS_PROVIDER: "http", TTS_HTTP_URL: "http://example.com/tts" }), /https/);
  const h = loadSettings({ TTS_PROVIDER: "http", TTS_HTTP_URL: "http://localhost:8787/tts", TTS_HTTP_REFERENCE_ID: "r1" }).tts;
  assert.ok(h.provider === "http" && h.http.referenceId === "r1" && h.http.token === undefined);
  assert.throws(() => loadSettings({ TTS_PROVIDER: "other" }), /TTS_PROVIDER/);
  assert.throws(() => loadSettings({ TTS_FALLBACK: "elevenlabs" }), /TTS_FALLBACK/);
});

test("settings: a stale SCHEDULER=legacy does not stop the agent; it is ignored with one warning line", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--conditions=workspace-source", "-e", 'import("./src/settings.ts").then((m) => console.log("scheduler" in m.settings))'], { env: { ...process.env, ...env }, encoding: "utf8" });
  const stale = run({ SCHEDULER: "legacy" });
  assert.equal(stale.status, 0);
  assert.equal(stale.stdout.trim(), "false"); // the setting is gone
  assert.equal(stale.stderr.split("\n").filter((l) => l.includes("SCHEDULER=legacy")).length, 1);
  assert.doesNotMatch(run({ SCHEDULER: "gate" }).stderr, /SCHEDULER/);
});

test("settings: the timing constants keep the values they had when they were hard-coded, and are validated", () => {
  const s = loadSettings({});
  const ms = { stickyMs: s.groupStickyMinutes * 60_000, noticeMs: s.groupNoticeMinutes * 60_000, memberMs: s.groupMemberCacheMinutes * 60_000, slowMs: s.slowReplySeconds * 1000, echoMs: s.echoWindowMinutes * 60_000, refreshMs: s.warmRefreshMinutes * 60_000, retryMs: s.briefRetryGapMinutes * 60_000, graceH: s.briefPendingGraceHours, seenMs: s.seenMailDays * 24 * 3600_000, noticeAgeMs: s.noticeAgeHours * 3600_000, backoffMs: s.compactBackoffMinutes * 60_000 };
  assert.deepEqual(ms, { stickyMs: 30 * 60_000, noticeMs: 10 * 60_000, memberMs: 5 * 60_000, slowMs: 20_000, echoMs: 5 * 60_000, refreshMs: 25 * 60_000, retryMs: 10 * 60_000, graceH: 3, seenMs: 14 * 24 * 3600_000, noticeAgeMs: 24 * 3600_000, backoffMs: 3600_000 });
  assert.equal(loadSettings({ GROUP_STICKY_MINUTES: "45" }).groupStickyMinutes, 45);
  assert.throws(() => loadSettings({ BRIEF_RETRY_GAP_MINUTES: "0" }), /BRIEF_RETRY_GAP_MINUTES/);
  assert.throws(() => loadSettings({ SLOW_REPLY_SECONDS: "soon" }), /SLOW_REPLY_SECONDS/);
});
