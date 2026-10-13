import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SignalClient } from "../src/client.ts";
import { FakeSignalDaemon, FakeRpcError, type FakeRequest } from "../src/testing.ts";

type Req = FakeRequest;
const RpcError = FakeRpcError;

const ME = "+10000000000";
const PEER = { number: "+10000000001", aci: "11111111-2222-3333-4444-555555555555" };
const wrap = (envelope: object) => ({ jsonrpc: "2.0", method: "receive", params: { envelope } });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(f(), "timed out waiting");
};

// Closed after every test, so a failing assertion cannot leave a server running and hang the runner.
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => void (await Promise.all(open.splice(0).map((d) => d.close()))));

async function connected(peer?: typeof PEER, answer?: (r: Req) => unknown) {
  const d = await FakeSignalDaemon.start(answer ?? ((r) => (r.method === "send" ? { timestamp: 1234 } : {})));
  const c = new SignalClient("127.0.0.1", d.port, ME, peer);
  await c.connect();
  await until(() => d.connections > 0); // the server sees the connection a moment after the client does
  open.push(d);
  return { d, c, done: () => d.close() };
}

test("client: framing handles several lines in one chunk and one line split over chunks", async () => {
  const { d, c, done } = await connected();
  const got: string[] = [];
  c.onMessage((m) => got.push(m.text));
  const env = (t: string) => JSON.stringify(wrap({ sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, message: t, timestamp: 1 } } }));
  d.raw(env("one") + "\n" + env("two") + "\n");
  const third = env("three") + "\n";
  d.raw(third.slice(0, 20));
  await new Promise((r) => setTimeout(r, 20));
  d.raw(third.slice(20));
  await until(() => got.length === 3);
  assert.deepEqual(got, ["one", "two", "three"]);
  await done();
});

test("client: an unparseable line is skipped and later lines still work", async () => {
  const { d, c, done } = await connected();
  const got: string[] = [];
  c.onMessage((m) => got.push(m.text));
  d.raw("{not json\n");
  d.push({ sourceNumber: ME, syncMessage: { sentMessage: { destinationNumber: ME, message: "ok", timestamp: 2 } } });
  await until(() => got.length === 1);
  await done();
});

test("client: responses are matched to requests by id, even out of order", async () => {
  const held: Req[] = [];
  const { d, c, done } = await connected(undefined, (r) => (held.push(r), undefined));
  const a = c.send("a");
  const b = c.send("b");
  await until(() => held.length === 2);
  d.reply(held[1]!.id, { timestamp: 22 });
  d.reply(held[0]!.id, { timestamp: 11 });
  assert.deepEqual(await Promise.all([a, b]), [11, 22]);
  await done();
});

test("client: an rpc error rejects that request with signal-cli's message", async () => {
  const { c, done } = await connected(undefined, () => new RpcError("Invalid number"));
  await assert.rejects(c.send("x"), /Invalid number/);
  await done();
});

test("client: send in Note to Self mode", async () => {
  const { d, c, done } = await connected();
  assert.equal(await c.send("hi"), 1234);
  assert.deepEqual(d.requests[0]!.params, { noteToSelf: true, message: "hi" });
  await done();
});

test("client: send in peer mode, with style, quote and attachments", async () => {
  const { d, c, done } = await connected(PEER);
  await c.send("hi", ["0:2:BOLD"], { text: "earlier", author: PEER.number, timestamp: 99 }, { attachments: ["/tmp/a.m4a"] });
  assert.deepEqual(d.requests[0]!.params, {
    recipient: [PEER.number],
    message: "hi",
    attachments: ["/tmp/a.m4a"],
    textStyle: ["0:2:BOLD"],
    quoteTimestamp: 99,
    quoteAuthor: PEER.number,
    quoteMessage: "earlier",
  });
  await done();
});

test("client: send to a group, attachment only", async () => {
  const { d, c, done } = await connected(PEER);
  await c.send("", [], undefined, { groupId: "grp==", attachments: ["/tmp/a.png"] });
  assert.deepEqual(d.requests[0]!.params, { groupId: "grp==", attachments: ["/tmp/a.png"] });
  await done();
});

test("client: react sends the target and is remembered as our own", async () => {
  const { d, c, done } = await connected(PEER);
  await c.react("👍", { author: PEER.number, timestamp: 5 });
  assert.deepEqual(d.requests[0]!.params, { recipient: [PEER.number], emoji: "👍", targetAuthor: PEER.number, targetTimestamp: 5 });
  assert.equal(c.isOwnReaction({ emoji: "👍", targetTimestamp: 5 }), true);
  assert.equal(c.isOwnReaction({ emoji: "👎", targetTimestamp: 5 }), false);
  await c.react("🔥", { author: PEER.number, timestamp: 6 }, "grp==");
  assert.equal(d.requests[1]!.params.groupId, "grp==");
  assert.equal(d.requests[1]!.params.recipient, undefined);
  await done();
});

test("client: a failed reaction is swallowed (best effort)", async () => {
  const { c, done } = await connected(PEER, () => new RpcError("nope"));
  await c.react("👍", { author: PEER.number, timestamp: 5 });
  await done();
});

test("client: typing and read receipts do nothing in Note to Self mode", async () => {
  const { d, c, done } = await connected();
  await c.typing();
  await c.markRead(1);
  assert.equal(d.requests.length, 0);
  await done();
});

test("client: typing in peer mode, direct and in a group", async () => {
  const { d, c, done } = await connected(PEER);
  await c.typing();
  await c.typing(true, "grp==");
  assert.deepEqual(d.requests[0]!.params, { recipient: [PEER.number] });
  assert.deepEqual(d.requests[1]!.params, { groupId: "grp==", stop: true });
  await done();
});

test("client: groups() maps members and drops groups we left", async () => {
  const { c, done } = await connected(PEER, () => [
    { id: "g1", name: "Team", members: [{ number: "+10000000002", uuid: "u2" }, "+10000000003", { uuid: "u4" }] },
    { id: "g2", name: "Old", isMember: false, members: [] },
  ]);
  assert.deepEqual(await c.groups(), [
    { id: "g1", name: "Team", members: [{ number: "+10000000002", uuid: "u2" }, { number: "+10000000003", uuid: "+10000000003" }, { number: undefined, uuid: "u4" }] },
  ]);
  await done();
});

test("client: an incoming reaction reaches the reaction handler", async () => {
  const { d, c, done } = await connected(PEER);
  const got: string[] = [];
  c.onReaction((r) => got.push(r.emoji));
  d.push({ sourceNumber: PEER.number, dataMessage: { timestamp: 7, reaction: { emoji: "👍", targetSentTimestamp: 5, targetAuthorNumber: ME } } });
  await until(() => got.length === 1);
  await done();
});

// signal-cli's sendReceipt takes ONE recipient string (unlike send/sendTyping/sendReaction, which take a list); a list
// made it fail with "Invalid phone number '[<uuid>]'" for peers known only by account id.
test("client: a read receipt names a single recipient string (peer, peer by account id, group author)", async () => {
  const { d, c, done } = await connected(PEER);
  await c.markRead(10);
  await c.markRead(11, PEER.aci);
  await c.markRead(12, "+10000000002");
  assert.deepEqual(d.requests.map((r) => r.method), ["sendReceipt", "sendReceipt", "sendReceipt"]);
  assert.deepEqual(d.requests.map((r) => r.params.recipient), [PEER.number, PEER.aci, "+10000000002"]);
  assert.deepEqual(d.requests.map((r) => r.params.targetTimestamp), [[10], [11], [12]]);
  assert.equal(d.requests[0]!.params.type, "read");
  await done();
});

test("client: warnings go to the injected logger (and nowhere by default)", async () => {
  const d = await FakeSignalDaemon.start(() => new RpcError("nope"));
  open.push(d);
  const lines: string[] = [];
  const c = new SignalClient("127.0.0.1", d.port, ME, PEER, { info: () => {}, error: () => {}, warn: (...a) => void lines.push(a.join(" ")) });
  await c.connect();
  await until(() => d.connections > 0);
  await c.markRead(1);
  d.raw("garbage\n");
  await c.react("x", { author: PEER.number, timestamp: 1 });
  await until(() => lines.length === 3);
  assert.match(lines.join("|"), /read receipt failed: nope/);
  assert.match(lines.join("|"), /unparseable line/);
  assert.match(lines.join("|"), /reaction x failed: nope/);
});

test("client: when signal-cli goes away onClose fires once and pending requests are rejected", async () => {
  const held: Req[] = [];
  const { d, c } = await connected(undefined, (r) => (held.push(r), undefined));
  const closes: { requested: boolean }[] = [];
  c.onClose((info) => closes.push(info));
  const p = c.send("x");
  await until(() => held.length === 1);
  d.dropConnections();
  await assert.rejects(p, /socket closed/);
  await until(() => closes.length === 1);
  assert.equal(closes[0]!.requested, false);
  await assert.rejects(c.send("y"), /closed/);
});

test("client: close() ends the connection on purpose", async () => {
  const { d, c } = await connected();
  const closes: { requested: boolean }[] = [];
  c.onClose((info) => closes.push(info));
  c.close();
  c.close();
  await until(() => closes.length === 1);
  assert.equal(closes[0]!.requested, true);
  await until(() => d.connections === 0);
});

test("client: a socket error after connecting is reported, not thrown", async () => {
  const { d, c } = await connected();
  const closes: { error?: Error }[] = [];
  c.onClose((info) => closes.push(info));
  d.resetConnections();
  await until(() => closes.length === 1);
  assert.ok(closes[0]!.error, "the reset is passed on");
});

test("client: sending before connect() says so", async () => {
  const c = new SignalClient("127.0.0.1", 1, ME);
  await assert.rejects(c.send("x"), /not connected/);
});
