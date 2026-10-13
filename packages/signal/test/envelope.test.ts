import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretEnvelope } from "../src/client.ts";

const ME = "+10000000000"; // the owner
const BOT = "+10000000001"; // the assistant's own account
const self = { account: ME };
const peer = { account: BOT, peer: ME };

test("self mode: the owner's Note to Self arrives as a sync of something they sent to themselves", () => {
  const env = { sourceNumber: ME, timestamp: 5, syncMessage: { sentMessage: { destinationNumber: ME, timestamp: 5, message: "hi" } } };
  assert.deepEqual(interpretEnvelope(env, self).message, { from: ME, text: "hi", timestamp: 5, direct: true, quote: undefined, audio: undefined });
});

test("self mode: a message to someone else, and a message from someone else, are not direct", () => {
  const toOther = { sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: "+15555550105", message: "x", timestamp: 1 } } };
  assert.equal(interpretEnvelope(toOther, self).message?.direct, false);
  const fromFriend = { sourceNumber: "+15555550105", timestamp: 2, dataMessage: { message: "hello", timestamp: 2 } };
  assert.equal(interpretEnvelope(fromFriend, self).message?.direct, false);
});

test("peer mode: the owner's chat message is direct, a stranger's or a group's is not", () => {
  const fromOwner = { sourceNumber: ME, timestamp: 7, dataMessage: { message: "hi bot", timestamp: 7 } };
  assert.equal(interpretEnvelope(fromOwner, peer).message?.direct, true);
  assert.equal(interpretEnvelope(fromOwner, peer).message?.from, ME);
  assert.equal(interpretEnvelope({ ...fromOwner, sourceNumber: "+15555550105" }, peer).message?.direct, false);
  const inGroup = { sourceNumber: ME, dataMessage: { message: "hi", timestamp: 1, groupInfo: { groupId: "g" } } };
  assert.equal(interpretEnvelope(inGroup, peer).message?.direct, false);
});

test("peer mode: an owner whose number Signal hides is matched by account id, and only by the configured one", () => {
  const hidden = { sourceUuid: "aaaa-1111", dataMessage: { message: "hi", timestamp: 1 } };
  assert.equal(interpretEnvelope(hidden, peer).message?.direct, false);
  assert.equal(interpretEnvelope(hidden, { ...peer, peerAci: "aaaa-1111" }).message?.direct, true);
  assert.equal(interpretEnvelope(hidden, { ...peer, peerAci: "aaaa-1111" }).message?.from, ME);
  assert.equal(interpretEnvelope({ sourceUuid: "bbbb-2222", dataMessage: { message: "hi" } }, { ...peer, peerAci: "aaaa-1111" }).message?.direct, false);
});

test("reactions carry their target and author, in both modes", () => {
  const r = { emoji: "👍", targetSentTimestamp: 99, targetAuthorNumber: BOT, isRemove: false };
  assert.deepEqual(interpretEnvelope({ sourceNumber: ME, dataMessage: { reaction: r } }, peer).reaction, { from: ME, emoji: "👍", targetTimestamp: 99, isRemove: false, direct: true, targetAuthor: BOT });
  const sync = { sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, reaction: r } } };
  assert.equal(interpretEnvelope(sync, self).reaction?.direct, true);
  assert.equal(interpretEnvelope({}, self).message, undefined);
  assert.deepEqual(interpretEnvelope(null, peer), {});
});

test("an attachment-only voice message is a message with audio and no text", () => {
  const env = { sourceNumber: ME, dataMessage: { timestamp: 3, attachments: [{ contentType: "audio/aac", id: "abc", size: 100 }] } };
  const m = interpretEnvelope(env, peer).message!;
  assert.equal(m.text, "");
  assert.deepEqual(m.audio, { id: "abc", size: 100 });
});
