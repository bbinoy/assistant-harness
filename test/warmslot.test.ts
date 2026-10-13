import { test } from "node:test";
import assert from "node:assert/strict";
import { SpareSlot } from "../src/warmslot.ts";
import { prepareGroupChat, runGroupTurn } from "../src/agent.ts";
import { group, owner } from "../src/conversation.ts";
import { createGroupBrain } from "../src/group.ts";
import { loadSettings, settings } from "../src/settings.ts";
import { writeJson } from "../src/state.ts";

const tick = () => new Promise((res) => setTimeout(res, 5));

// ---- the slot ----

const fakeWarm = (name: string, closed: string[]) => Promise.resolve({ name, close: () => void closed.push(name) });

test("warm slot: holds one process; a replacement closes the old one", async () => {
  const closed: string[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({ maxAgeMs: 1000 });
  slot.put("a", "k1", fakeWarm("A", closed));
  assert.equal(slot.holder, "a");
  slot.put("b", "k2", fakeWarm("B", closed)); // another group became the latest
  await tick();
  assert.deepEqual(closed, ["A"]);
  assert.equal(slot.holder, "b");
  assert.equal(slot.has("a"), false);
  assert.equal(slot.has("b"), true);
});

test("warm slot: handed out only to the same conversation with the same key, once", async () => {
  const closed: string[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({ maxAgeMs: 1000 });
  slot.put("a", "k1", fakeWarm("A", closed));
  assert.equal(slot.take("b", "k1"), undefined); // never shared with another conversation...
  assert.equal(slot.holder, "a"); // ...and not disturbed by it
  assert.equal(slot.take("a", "other-key"), undefined); // state moved on: a stale process is closed, not used
  await tick();
  assert.deepEqual(closed, ["A"]);
  assert.equal(slot.holder, undefined);
  slot.put("a", "k2", fakeWarm("A2", closed));
  assert.equal((await slot.take("a", "k2"))?.name, "A2");
  assert.equal(slot.take("a", "k2"), undefined); // serves one query
  assert.deepEqual(closed, ["A"]); // taken, so not closed by the slot
});

test("warm slot: too old is not used, a failed start empties the slot, idle drops it and activity restarts the wait", async () => {
  let t = 0;
  const closed: string[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const slot = new SpareSlot<{ name: string; close(): void }>({
    maxAgeMs: 1000,
    idleMs: () => 600,
    now: () => t,
    schedule: (fn, ms) => {
      const x = { fn, ms, live: true };
      timers.push(x);
      return () => void (x.live = false);
    },
  });
  slot.put("a", "k", fakeWarm("A", closed));
  t = 1500;
  assert.equal(slot.has("a"), false);
  assert.equal(slot.take("a", "k"), undefined);
  await tick();
  assert.deepEqual(closed, ["A"]);

  t = 0;
  slot.put("a", "k", Promise.reject(new Error("no start")));
  await tick();
  assert.equal(slot.holder, undefined);

  slot.put("a", "k", fakeWarm("B", closed));
  assert.equal(timers.filter((x) => x.live).length, 1);
  slot.touch("a"); // the group is still talking: the old timer is cancelled and a new one runs
  assert.equal(timers.filter((x) => x.live).length, 1);
  slot.touch("zzz");
  assert.equal(timers.filter((x) => x.live).length, 1);
  timers.find((x) => x.live)!.fn(); // idle period over
  await tick();
  assert.equal(slot.holder, undefined);
  assert.deepEqual(closed, ["A", "B"]);
});

// ---- groups in agent.ts ----

const result = { type: "result", subtype: "success", is_error: false, result: "hi", session_id: "sess-new", total_cost_usd: 0.001 };
const stream = (log: string[], name: string) => (async function* () { log.push(name); yield result; })();
const warmFor = (name: string, used: string[], closed: string[]) => ({ query: () => stream(used, name), close: () => void closed.push(name), [Symbol.asyncDispose]: async () => {} });
const startRig = () => {
  const started: any[] = [];
  const used: string[] = [];
  const closed: string[] = [];
  const start = ((o: any) => (started.push(o.options), Promise.resolve(warmFor(`warm${started.length}`, used, closed)))) as any;
  return { started, used, closed, start };
};
const coldQuery = (log: string[]) => (() => stream(log, "cold")) as any;
const build = () => ({ prompt: "p" });
let n = 0;
const gid = () => `warm-${++n}-0123456789abcdef`;

test("group warm: built from that group's own options only, exactly like a normal group run", () => {
  const was = settings.groupWarm;
  (settings as { groupWarm: boolean }).groupWarm = true;
  try {
    const rig = startRig();
    const conv = group(gid());
    prepareGroupChat(conv, () => "- be warm", { start: rig.start });
    assert.equal(rig.started.length, 1);
    const o = rig.started[0];
    assert.deepEqual(o.settings, { autoMemoryEnabled: true, autoMemoryDirectory: conv.notesDir });
    assert.notEqual(conv.notesDir, owner().notesDir);
    assert.deepEqual([o.settingSources, o.strictMcpConfig, o.plugins, o.skills, Object.keys(o.mcpServers ?? {})], [[], true, undefined, undefined, ["memory"]]);
    assert.deepEqual(o.tools, ["Read", "Write", "Edit", "WebSearch"]);
    assert.match(JSON.stringify(o.systemPrompt), /be warm/);
  } finally {
    (settings as { groupWarm: boolean }).groupWarm = was;
  }
});

test("group warm: one process for the latest group; another group replaces it; each group only ever gets its own", async () => {
  const was = settings.groupWarm;
  (settings as { groupWarm: boolean }).groupWarm = true;
  try {
    const rig = startRig();
    const a = group(gid());
    const b = group(gid());
    prepareGroupChat(a, () => "", { start: rig.start });
    prepareGroupChat(a, () => "", { start: rig.start }); // already warm for a: nothing new started
    assert.equal(rig.started.length, 1);
    prepareGroupChat(b, () => "", { start: rig.start }); // b spoke last
    await tick();
    assert.equal(rig.started.length, 2);
    assert.deepEqual(rig.closed, ["warm1"]); // a's was dropped: at most one group process
    // a runs cold (its warm process is gone) and never on b's process
    const log: string[] = [];
    await runGroupTurn(a, "", build, undefined, { query: coldQuery(log) });
    assert.deepEqual(log, ["cold"]);
    assert.deepEqual(rig.used, []);
    // b uses its own
    await runGroupTurn(b, "", build, undefined, { query: coldQuery(log) });
    assert.deepEqual(rig.used, ["warm2"]);
    assert.deepEqual(log, ["cold"]);
  } finally {
    (settings as { groupWarm: boolean }).groupWarm = was;
  }
});

test("group warm: a process built before the session moved on is not used", async () => {
  const was = settings.groupWarm;
  (settings as { groupWarm: boolean }).groupWarm = true;
  try {
    const rig = startRig();
    const conv = group(gid());
    prepareGroupChat(conv, () => "", { start: rig.start });
    writeJson(conv.sessionFile, { sessionId: "moved-on", costUsd: 0, lastTurnAt: new Date().toISOString() }); // a turn happened meanwhile
    const log: string[] = [];
    await runGroupTurn(conv, "", build, undefined, { query: coldQuery(log) });
    assert.deepEqual(log, ["cold"]);
    assert.deepEqual(rig.used, []);
    await tick();
    assert.deepEqual(rig.closed, ["warm1"]);
  } finally {
    (settings as { groupWarm: boolean }).groupWarm = was;
  }
});

test("group warm: GROUP_WARM=off starts nothing, and the setting is validated", async () => {
  assert.equal(loadSettings({}).groupWarm, true);
  assert.equal(loadSettings({ GROUP_WARM: "off" }).groupWarm, false);
  assert.throws(() => loadSettings({ GROUP_WARM: "maybe" }), /GROUP_WARM/);
  assert.equal(loadSettings({}).groupWarmIdleMinutes, 10);
  assert.throws(() => loadSettings({ GROUP_WARM_IDLE_MINUTES: "0" }), /GROUP_WARM_IDLE_MINUTES/);
  const was = settings.groupWarm;
  (settings as { groupWarm: boolean }).groupWarm = false;
  try {
    const rig = startRig();
    prepareGroupChat(group(gid()), () => "", { start: rig.start });
    prepareGroupChat(group(gid()), () => "", { start: rig.start, force: true });
    assert.equal(rig.started.length, 0);
  } finally {
    (settings as { groupWarm: boolean }).groupWarm = was;
  }
});

// ---- when the group brain asks for it ----

test("group warm: asked when a message arrives and after a turn, not while the group's own turn runs, not for tagged-only chatter", async () => {
  (settings as { dailyBudgetUsd: number }).dailyBudgetUsd = Infinity; // other test files share the data dir, and one of them spends the day's budget
  const calls: string[] = [];
  const sent: string[] = [];
  let hold: Promise<void> = Promise.resolve();
  const brain = createGroupBrain({
    pipeline: {
      record: () => {},
      react: () => {},
      wait: async () => {},
      canSpeak: () => false,
      enqueue: (_c: any, j: any) => j(),
      burstQueued: () => false,
      holdTyping: () => () => {},
      burst: async (_c: any, m: any, settled: any) => settled({ stale: () => false, timing: { set() {}, mark() {} }, run: (job: any) => job([m]) }),
      runTurn: async (_c: any, t: any) => (calls.push("turn"), await hold, sent.push((await t.run({ firstOutput() {} })).text), { spoke: true }),
    } as any,
    recent: () => [],
    run: async () => "ok",
    gate: async () => ({ act: true, task: "task" as const, delaySeconds: 0, nextCheckMinutes: 30 }),
    warm: (_c, after) => void calls.push(after ? "warm after" : "warm arrival"),
  });
  const g = gid();
  await brain({ groupId: g, text: "@Ted hi", timestamp: 1, isOwner: false, addressedToMe: true, author: "+1" });
  assert.deepEqual(calls, ["warm arrival", "turn", "warm after"]);
  calls.length = 0;
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  const first = brain({ groupId: g, text: "@Ted again", timestamp: 3, isOwner: false, addressedToMe: true, author: "+1" });
  await tick();
  const second = brain({ groupId: g, text: "@Ted and more", timestamp: 4, isOwner: false, addressedToMe: true, author: "+1" });
  await tick();
  release();
  await Promise.all([first, second]);
  assert.equal(calls.filter((c) => c === "warm arrival").length, 1); // none for the message that came while the turn ran
  const was = settings.groupParticipation;
  (settings as { groupParticipation: string }).groupParticipation = "tagged";
  try {
    calls.length = 0;
    await brain({ groupId: g, text: "chatter", timestamp: 2, isOwner: false, addressedToMe: false, author: "+1" });
    assert.deepEqual(calls, []); // nothing will be answered: no process for it
  } finally {
    (settings as { groupParticipation: string }).groupParticipation = was;
  }
});
