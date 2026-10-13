import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReaction } from "../src/reaction.ts";

test("reaction: one emoji at the very start is a reaction; the rest is still said", () => {
  assert.deepEqual(splitReaction("[[react: 👍]]"), { reaction: "👍", text: "" });
  assert.deepEqual(splitReaction("[[react:😂]] Good one, Captain."), { reaction: "😂", text: "Good one, Captain." });
  assert.deepEqual(splitReaction("  [[react: ❤️]]\n\nThanks!"), { reaction: "❤️", text: "Thanks!" });
  assert.deepEqual(splitReaction("[[react: 👍🏽]] ok"), { reaction: "👍🏽", text: "ok" }); // skin tone is one emoji
});

test("reaction: anything else is plain text, never a reaction", () => {
  for (const s of ["Sure thing [[react: 👍]]", "[[react: ok]]", "[[react: 👍👍]]", "[[react: ]]", "[[react: 1]]", "react: 👍", "Hello"]) assert.deepEqual(splitReaction(s), { text: s }, s);
});
