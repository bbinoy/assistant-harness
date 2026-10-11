import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutbound } from "../src/outbound.ts";

// A fake Signal client that records what is sent and can deliver the echo BEFORE the send returns.
function fake() {
  const sent: { text: string; styles: string[] }[] = [];
  let ts = 1000;
  const signal = { sendNoteToSelf: async (text: string, styles: string[] = []) => (sent.push({ text, styles }), ++ts) } as any;
  return { signal, sent };
}

test("no robot prefix on outgoing messages", async () => {
  const { signal, sent } = fake();
  await createOutbound(signal).reply("hello **world**");
  assert.equal(sent[0]!.text, "hello world");
  assert.deepEqual(sent[0]!.styles, ["6:5:BOLD"]); // offsets start at 0 now, no prefix shift
});

test("echo guard: our own reply is recognised even before the send returns", async () => {
  const { signal } = fake();
  let out!: ReturnType<typeof createOutbound>;
  // the echo "arrives" while the send is still in flight
  signal.sendNoteToSelf = async (text: string) => {
    assert.equal(out.isOwnEcho({ text, timestamp: 999 }), true, "echo must be recognised by text, timestamp unknown yet");
    return 1234;
  };
  out = createOutbound(signal);
  await out.reply("some answer");
});

test("echo guard: plain and styled sends are both registered, a user's own text is not", async () => {
  const { signal } = fake();
  const out = createOutbound(signal);
  await out.replyPlain("Approve?\n📅 Create calendar event");
  await out.reply("**Focus** today");
  assert.equal(out.isOwnEcho({ text: "Approve?\n📅 Create calendar event", timestamp: 1 }), true);
  assert.equal(out.isOwnEcho({ text: "Focus today", timestamp: 2 }), true);
  assert.equal(out.isOwnEcho({ text: "what's on my calendar?", timestamp: 3 }), false);
});

test("echo guard: known timestamps are recognised even when the text differs", async () => {
  const { signal } = fake();
  const out = createOutbound(signal);
  await out.reply("x"); // timestamp 1001
  assert.equal(out.isOwnEcho({ text: "different text", timestamp: 1001 }), true);
  assert.equal(out.isOwnEcho({ text: "different text", timestamp: 1002 }), false);
});
