import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretEnvelope, parseFile, parseImage } from "../src/envelope.ts";

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

// ---- groups (own-account mode) ----
const BOTACCT = "00000000-0000-4000-8000-000000000001";
const GID = "Zm9vYmFyZm9vYmFyZm9vYmFy";
const peerCh = { account: BOTACCT, peer: ME };
import { withMentions } from "../src/envelope.ts";

test("groups: a group message is never direct; it says whether it is addressed to the assistant", () => {
  const plain = { sourceNumber: "+15555550105", sourceUuid: "u-1", sourceName: "Eve", timestamp: 1, dataMessage: { message: "hello all", timestamp: 1, groupInfo: { groupId: GID } } };
  const m = interpretEnvelope(plain, peerCh).message!;
  assert.equal(m.direct, false);
  assert.equal(m.group?.id, GID);
  assert.equal(m.addressedToMe, false);
  assert.equal(m.fromName, "Eve");
  const mention = { ...plain, dataMessage: { ...plain.dataMessage, message: "￼ what's the weather?", mentions: [{ uuid: BOTACCT, name: "Ted", start: 0, length: 1 }] } };
  const mm = interpretEnvelope(mention, peerCh).message!;
  assert.equal(mm.addressedToMe, true);
  assert.equal(mm.text, "@Ted what's the weather?");
  const reply = { ...plain, dataMessage: { ...plain.dataMessage, quote: { id: 5, author: BOTACCT, text: "earlier" } } };
  assert.equal(interpretEnvelope(reply, peerCh).message!.addressedToMe, true);
  const other = { ...plain, dataMessage: { ...plain.dataMessage, quote: { id: 5, author: "u-9", text: "x" } } };
  assert.equal(interpretEnvelope(other, peerCh).message!.addressedToMe, false);
  // in Note to Self mode groups are not ours at all
  assert.equal(interpretEnvelope(plain, { account: ME }).message?.group, undefined);
  // the owner writing in a group is still not "direct"
  assert.equal(interpretEnvelope({ ...plain, sourceNumber: ME }, peerCh).message!.direct, false);
  assert.equal(withMentions("a ￼ b", [{ start: 2, name: "Ted" }]), "a @Ted b");
});


test("images: JPEG, PNG, WebP, GIF and HEIC are accepted; videos, other files, odd names and huge files are not", () => {
  assert.deepEqual(parseImage([{ contentType: "image/jpeg", id: "abc-DEF_1.jpg", size: 400000 }]), { id: "abc-DEF_1.jpg", size: 400000 });
  for (const t of ["image/png", "image/webp", "image/gif", "image/heic", "image/heif"]) assert.ok(parseImage([{ contentType: t, id: "x", size: 5 }]));
  assert.equal(parseImage([{ contentType: "video/mp4", id: "v", size: 5 }]), undefined);
  assert.equal(parseImage([{ contentType: "application/pdf", id: "d", size: 5 }]), undefined);
  assert.equal(parseImage([{ contentType: "image/svg+xml", id: "s", size: 5 }]), undefined);
  assert.equal(parseImage([{ contentType: "image/jpeg", id: "../../.ssh/id_rsa", size: 5 }]), undefined);
  assert.equal(parseImage([{ contentType: "image/jpeg", id: ".hidden", size: 5 }]), undefined);
  assert.equal(parseImage([{ contentType: "image/jpeg", id: "big", size: 99_000_000 }]), undefined);
  assert.equal(parseImage(undefined), undefined);
});

test("images: a picture with or without a caption is a message, in a private chat and in a group", () => {
  const att = [{ contentType: "image/jpeg", id: "p1.jpg", size: 1000 }];
  const direct = interpretEnvelope({ sourceNumber: ME, timestamp: 7, dataMessage: { timestamp: 7, attachments: att } }, peer).message;
  assert.deepEqual([direct?.text, direct?.image, direct?.direct], ["", { id: "p1.jpg", size: 1000 }, true]);
  const grp = interpretEnvelope({ sourceNumber: "+15555550105", timestamp: 8, dataMessage: { timestamp: 8, message: "look", attachments: att, groupInfo: { groupId: "g1" } } }, peer).message;
  assert.deepEqual([grp?.text, grp?.image?.id, grp?.group?.id], ["look", "p1.jpg", "g1"]);
  const video = interpretEnvelope({ sourceNumber: ME, timestamp: 9, dataMessage: { timestamp: 9, attachments: [{ contentType: "video/mp4", id: "v", size: 5 }] } }, peer).message;
  assert.deepEqual([video?.image, video?.file], [undefined, { id: "v", size: 5 }]); // a video is a file now: the app tells the sender it is not supported
});

test("files: the first attachment that is not a picture or audio; ids and sizes are checked, the name is cut and never a path", () => {
  assert.deepEqual(parseFile([{ contentType: "application/pdf", id: "d1", size: 900, filename: "Report 2026.pdf" }]), { id: "d1", size: 900, name: "Report 2026.pdf" });
  assert.deepEqual(parseFile([{ contentType: "image/jpeg", id: "p", size: 5 }, { contentType: "audio/aac", id: "a", size: 5 }, { id: "z", size: 7 }]), { id: "z", size: 7 });
  assert.equal(parseFile([{ contentType: "image/png", id: "p", size: 5 }]), undefined);
  assert.equal(parseFile([{ contentType: "application/pdf", id: "../../etc/passwd", size: 5 }]), undefined);
  assert.equal(parseFile([{ contentType: "application/pdf", id: ".hidden", size: 5 }]), undefined);
  assert.equal(parseFile([{ contentType: "application/pdf", id: "empty", size: 0 }]), undefined);
  assert.equal(parseFile("nope"), undefined);
  assert.equal(parseFile([{ contentType: "application/pdf", id: "d", size: 5, filename: "x".repeat(500) }])?.name?.length, 200);
  const m = interpretEnvelope({ sourceNumber: "+15555550105", timestamp: 8, dataMessage: { timestamp: 8, message: "see", attachments: [{ contentType: "application/pdf", id: "d2", size: 50, filename: "a.pdf" }], groupInfo: { groupId: "g1" } } }, peer).message;
  assert.deepEqual([m?.text, m?.file?.id, m?.group?.id, m?.image], ["see", "d2", "g1", undefined]);
});

// The shapes below follow signal-cli's JSON-RPC output (JsonMessageEnvelope, JsonEditMessage, JsonSyncDataMessage, JsonRemoteDelete).
const FRIEND = "+15555550105";

test("edits: an edit in a private chat is a message that says which one it replaces", () => {
  const env = { sourceNumber: ME, timestamp: 20, editMessage: { targetSentTimestamp: 7, dataMessage: { timestamp: 20, message: "hi bot, corrected" } } };
  const m = interpretEnvelope(env, peer).message!;
  assert.deepEqual([m.text, m.timestamp, m.direct, m.from, m.edited], ["hi bot, corrected", 20, true, ME, { targetTimestamp: 7 }]);
  assert.equal(interpretEnvelope({ ...env, sourceNumber: FRIEND }, peer).message?.direct, false);
});

test("edits: an edit in a group keeps the group and the mention; pictures and audio are not carried over", () => {
  const env = {
    sourceNumber: FRIEND, sourceUuid: "u-1", sourceName: "Eve", timestamp: 21,
    editMessage: { targetSentTimestamp: 8, dataMessage: { timestamp: 21, message: "￼ what time?", mentions: [{ start: 0, length: 1, uuid: BOT, name: "Ted" }], groupInfo: { groupId: "g1" }, attachments: [{ contentType: "image/jpeg", id: "p.jpg", size: 5 }] } },
  };
  const m = interpretEnvelope(env, peer).message!;
  assert.deepEqual([m.text, m.group, m.addressedToMe, m.edited, m.image, m.fromName], ["@Ted what time?", { id: "g1" }, true, { targetTimestamp: 8 }, undefined, "Eve"]);
});

test("edits: the owner's own edit from another device (Note to Self) arrives as a sync with an editMessage", () => {
  const env = { sourceNumber: ME, timestamp: 22, syncMessage: { sentMessage: { destinationNumber: ME, timestamp: 22, editMessage: { targetSentTimestamp: 5, dataMessage: { timestamp: 22, message: "buy oat milk" } } } } };
  const m = interpretEnvelope(env, self).message!;
  assert.deepEqual([m.text, m.timestamp, m.direct, m.edited], ["buy oat milk", 22, true, { targetTimestamp: 5 }]);
  const toOther = { ...env, syncMessage: { sentMessage: { ...env.syncMessage.sentMessage, destinationNumber: FRIEND } } };
  assert.equal(interpretEnvelope(toOther, self).message?.direct, false);
  assert.equal(interpretEnvelope({ sourceNumber: FRIEND, editMessage: env.syncMessage.sentMessage.editMessage }, self).message?.direct, false); // someone else's edit
});

test("edits: an edit that names no target is dropped, never taken for a new message; an edit is never a reaction or a delete", () => {
  assert.deepEqual(interpretEnvelope({ sourceNumber: ME, editMessage: { dataMessage: { timestamp: 3, message: "x" } } }, peer), {});
  assert.deepEqual(interpretEnvelope({ sourceNumber: ME, editMessage: { targetSentTimestamp: 0, dataMessage: { timestamp: 3, message: "x" } } }, peer), {});
  const odd = { sourceNumber: ME, editMessage: { targetSentTimestamp: 4, dataMessage: { timestamp: 3, reaction: { emoji: "👍", targetSentTimestamp: 1 }, remoteDelete: { targetTimestamp: 1 } } } };
  assert.deepEqual(interpretEnvelope(odd, peer), {});
  assert.equal(interpretEnvelope({ sourceNumber: ME, dataMessage: { timestamp: 3, message: "plain" } }, peer).message?.edited, undefined);
});

test("deletes: a remote delete names the message, in a private chat, a group and Note to Self (a sync)", () => {
  const priv = interpretEnvelope({ sourceNumber: ME, dataMessage: { timestamp: 30, remoteDelete: { targetTimestamp: 7, timestamp: 7 } } }, peer);
  assert.deepEqual(priv, { deletion: { from: ME, targetTimestamp: 7, direct: true } });
  const grp = interpretEnvelope({ sourceNumber: FRIEND, sourceUuid: "u-1", sourceName: "Eve", dataMessage: { timestamp: 31, remoteDelete: { targetTimestamp: 8 }, groupInfo: { groupId: "g1" } } }, peer);
  assert.deepEqual(grp, { deletion: { from: FRIEND, targetTimestamp: 8, direct: false, group: { id: "g1" }, fromUuid: "u-1", fromName: "Eve" } });
  const sync = interpretEnvelope({ sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, timestamp: 32, remoteDelete: { targetTimestamp: 5, timestamp: 5 } } } }, self);
  assert.deepEqual(sync, { deletion: { from: ME, targetTimestamp: 5, direct: true } });
  assert.deepEqual(interpretEnvelope({ sourceNumber: ME, dataMessage: { timestamp: 1, remoteDelete: { timestamp: 9 } } }, peer).deletion?.targetTimestamp, 9); // older signal-cli: only `timestamp`
  assert.deepEqual(interpretEnvelope({ sourceNumber: ME, dataMessage: { timestamp: 1, remoteDelete: {} } }, peer), {});
});
