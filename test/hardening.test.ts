import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptOwner } from "../src/guards.ts";
import { redact } from "../src/redact.ts";

const OWNER = "+15555550114";

test("allowlist: only the owner's own Note to Self is accepted (messages and reactions alike)", () => {
  assert.equal(acceptOwner({ from: OWNER, noteToSelf: true }, OWNER), true);
  assert.equal(acceptOwner({ from: OWNER, noteToSelf: false }, OWNER), false); // owner writing to someone else
  assert.equal(acceptOwner({ from: "+15555550105", noteToSelf: true }, OWNER), false);
  assert.equal(acceptOwner({ from: "+15555550105", noteToSelf: false }, OWNER), false); // a friend messaging the owner
  assert.equal(acceptOwner({ from: "", noteToSelf: true }, ""), false); // misconfigured: empty owner accepts nothing
});

test("redact: phone numbers and credentials never reach a log", () => {
  assert.equal(redact("dropped message from +15555550105"), "dropped message from +***05");
  assert.equal(redact("key sk-ant-api03-abcdefghijklmnop done"), "key sk-ant-*** done");
  assert.equal(redact("Authorization: Bearer abcDEF123456789xyz"), "Authorization: Bearer ***");
  assert.equal(redact("CLAUDE_CODE_OAUTH_TOKEN=supersecretvalue"), "CLAUDE_CODE_OAUTH_TOKEN=***");
  assert.equal(redact("plain text, 12 items"), "plain text, 12 items");
});

test("handler report: only what it did is 'Handled'; the rest is 'left for you'", async () => {
  const { formatReport } = await import("../src/handler.ts");
  assert.equal(formatReport("Armon: left for Ben (calendar update, nothing to do)", "Ben"), "👀 Left for you (1):\nArmon: left for Ben (calendar update, nothing to do)");
  assert.equal(formatReport("Riker: drafted a reply offering Tue 15:00", "Ben"), "🤝 Handled 1:\nRiker: drafted a reply offering Tue 15:00");
  const both = formatReport("Riker: drafted a reply\nQuark: left for Ben (needs a decision)", "Ben");
  assert.match(both, /🤝 Handled 1:\nRiker[\s\S]*👀 Left for you \(1\):\nQuark/);
  assert.equal(formatReport("", "Ben"), "🤝 Looked at it, nothing to report.");
});
