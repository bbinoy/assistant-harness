import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/index.ts";
import * as voice from "../src/voice.ts";
import * as tts from "../src/speech.ts";
import * as testing from "../src/testing.ts";

// The public surface, written down: an accidental addition or removal shows up here and is a deliberate change
// (and, after 1.0, a semver decision).
const names = (m: object) => Object.keys(m).sort();

test("exports: core entry", () => {
  assert.deepEqual(names(core), [
    "MAX_AUDIO_BYTES",
    "MAX_FILE_BYTES",
    "MAX_IMAGE_BYTES",
    "SignalClient",
    "attachmentPath",
    "defaultAttachmentsDir",
    "ensureSignalDaemon",
    "interpretEnvelope",
    "parseAudio",
    "parseFile",
    "parseImage",
    "parseQuote",
    "silentLogger",
    "withMentions",
  ]);
});

test("exports: ./voice", () => {
  assert.deepEqual(names(voice), ["cleanTranscript", "transcribe", "voiceReady"]);
});

test("exports: ./tts", () => {
  assert.deepEqual(names(tts), ["MAX_SPOKEN_CHARS", "isSafeUrl", "providerReady", "qwenReady", "stopQwen", "synthesize", "synthesizeQwen", "synthesizeWith", "ttsReady", "warmQwen"]);
});

test("exports: ./testing", () => {
  assert.deepEqual(names(testing), ["FakeRpcError", "FakeSignalDaemon"]);
});
