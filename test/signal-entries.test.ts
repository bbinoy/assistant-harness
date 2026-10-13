import { test } from "node:test";
import assert from "node:assert/strict";

// The app reaches the signal package only through its public entry points (never packages/signal/src paths):
// every one must resolve from here, which is how a broken `exports` map would show up.
test("the signal package entry points the app uses resolve", async () => {
  const core = await import("@ted-personal-assistant/signal");
  const voice = await import("@ted-personal-assistant/signal/voice");
  const tts = await import("@ted-personal-assistant/signal/tts");
  const testing = await import("@ted-personal-assistant/signal/testing");
  assert.equal(typeof core.SignalClient, "function");
  assert.equal(typeof voice.transcribe, "function");
  assert.equal(typeof tts.synthesizeWith, "function");
  assert.equal(typeof testing.FakeSignalDaemon, "function");
});
