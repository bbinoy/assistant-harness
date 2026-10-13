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
