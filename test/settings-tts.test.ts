import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings.ts";

test("settings: Kokoro is the default speech provider, with no fallback", () => {
  const s = loadSettings({});
  assert.equal(s.tts.provider, "kokoro");
  assert.equal(s.tts.fallback, "none");
});

test("settings: remote speech needs its keys and a safe address, or the agent does not start", () => {
  assert.throws(() => loadSettings({ TTS_PROVIDER: "elevenlabs" }), /ELEVENLABS_API_KEY/);
  // read once into settings, then gone from the environment every child process (Claude Code, MCP servers, ffmpeg) inherits
  const probe = "import('./src/settings.ts').then(({ settings }) => console.log(JSON.stringify([process.env.ELEVENLABS_API_KEY ?? null, process.env.TTS_HTTP_TOKEN ?? null, settings.tts.provider === 'elevenlabs' && settings.tts.elevenlabs.apiKey])))";
  const out = execFileSync(process.execPath, ["--conditions=workspace-source", "-e", probe], { encoding: "utf8", env: { PATH: process.env.PATH, TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "key-123456", ELEVENLABS_VOICE_ID: "v", TTS_HTTP_TOKEN: "tok-123456", HARNESS_DATA_DIR: process.env.HARNESS_DATA_DIR } });
  assert.equal(out.trim(), JSON.stringify([null, null, "key-123456"]));
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

test("settings: the timing constants keep the values they had when they were hard-coded, and are validated", () => {
  const s = loadSettings({});
  const ms = { stickyMs: s.groupStickyMinutes * 60_000, noticeMs: s.groupNoticeMinutes * 60_000, memberMs: s.groupMemberCacheMinutes * 60_000, slowMs: s.slowReplySeconds * 1000, echoMs: s.echoWindowMinutes * 60_000, refreshMs: s.warmRefreshMinutes * 60_000, retryMs: s.briefRetryGapMinutes * 60_000, graceH: s.briefPendingGraceHours, seenMs: s.seenMailDays * 24 * 3600_000, noticeAgeMs: s.noticeAgeHours * 3600_000, backoffMs: s.compactBackoffMinutes * 60_000 };
  assert.deepEqual(ms, { stickyMs: 30 * 60_000, noticeMs: 10 * 60_000, memberMs: 5 * 60_000, slowMs: 20_000, echoMs: 5 * 60_000, refreshMs: 25 * 60_000, retryMs: 10 * 60_000, graceH: 3, seenMs: 14 * 24 * 3600_000, noticeAgeMs: 24 * 3600_000, backoffMs: 3600_000 });
  assert.equal(loadSettings({ GROUP_STICKY_MINUTES: "45" }).groupStickyMinutes, 45);
  assert.throws(() => loadSettings({ BRIEF_RETRY_GAP_MINUTES: "0" }), /BRIEF_RETRY_GAP_MINUTES/);
  assert.throws(() => loadSettings({ SLOW_REPLY_SECONDS: "soon" }), /SLOW_REPLY_SECONDS/);
});

test("settings: the local cloned voice (qwen) takes its reference from paths, falls back to Kokoro by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "ref-"));
  writeFileSync(join(dir, "ref.txt"), "  Words spoken in the reference.\n");
  const q = loadSettings({ TTS_PROVIDER: "qwen", HARNESS_DATA_DIR: dir, TTS_REF_AUDIO: "ref.wav", TTS_REF_TEXT: "ref.txt", WARM_IDLE_MINUTES: "30" }).tts;
  assert.ok(q.provider === "qwen");
  assert.equal(q.fallback, "kokoro");
  assert.equal(q.qwen.refAudio, join(dir, "ref.wav"));
  assert.equal(q.qwen.refText, "Words spoken in the reference.");
  assert.equal(q.qwen.dir, join(dir, "state/tts-qwen"));
  assert.equal(q.qwen.idleMs, 30 * 60_000);
  assert.match(q.qwen.model, /Qwen3-TTS-12Hz-0\.6B-Base-8bit$/);
  const inline = loadSettings({ TTS_PROVIDER: "qwen", TTS_REF_TEXT: "Just these words." }).tts;
  assert.ok(inline.provider === "qwen" && inline.qwen.refText === "Just these words." && inline.qwen.refAudio === "");
  assert.ok(loadSettings({ TTS_PROVIDER: "qwen", TTS_FALLBACK: "none" }).tts.fallback === "none");
  rmSync(dir, { recursive: true, force: true });
});
