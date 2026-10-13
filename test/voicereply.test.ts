import test from "node:test";
import assert from "node:assert/strict";
import { voiceOption, SPOKEN_STYLE } from "../src/voicereply.ts";
import { isVoiceSpec } from "@ted-personal-assistant/signal";

test("the voice option tells the model to write for the ear, and only when speech is set up", () => {
  assert.ok(voiceOption(true).includes(SPOKEN_STYLE));
  assert.match(SPOKEN_STYLE, /short sentences/);
  assert.match(SPOKEN_STYLE, /numbers, dates, times/);
  assert.equal(voiceOption(false), "");
});

test("voice settings: one voice or a weighted blend; anything else is refused", () => {
  for (const ok of ["am_onyx", "am_adam,am_onyx", "am_adam:0.6,am_onyx:0.4", "bm_george:2"]) assert.ok(isVoiceSpec(ok), ok);
  for (const bad of ["", "onyx", "am_onyx,", "am_onyx:", "am_onyx; rm -rf", "../x", "am_onyx:0,am_adam:0", "AM_ONYX"]) assert.ok(!isVoiceSpec(bad), bad);
});
