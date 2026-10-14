import { test } from "node:test";
import assert from "node:assert/strict";
import { forTask, runJudge, discardJudge, prepareJudge, withTimeout } from "../src/approvaljudge.ts";
import { judgeReply, parseReply } from "../src/judge.ts";
import { judgeAction, parseVerdict } from "../src/autojudge.ts";
import { settings } from "../src/settings.ts";

const setWarm = (v: boolean) => ((settings as { warm: boolean }).warm = v);
const result = (out: unknown) => ({ type: "result", subtype: "success", is_error: false, structured_output: out }) as any;
async function* one(msg: unknown, log: string[], tag: string, prompts: string[], prompt: string) {
  log.push(tag);
  prompts.push(prompt);
  yield msg;
}
// Every process answers with `answer` and says which one it was; the prompts they were given are collected.
function rig(answer: unknown) {
  const log: string[] = [];
  const prompts: string[] = [];
  let n = 0;
  return {
    log,
    prompts,
    started: () => n,
    io: {
      start: (async () => {
        const tag = `warm${++n}`;
        return { query: (p: string) => one(result(answer), log, tag, prompts, p), close() {} };
      }) as any,
      query: ((a: { prompt: string }) => one(result(answer), log, "cold", prompts, a.prompt)) as any,
    },
  };
}
// A finished action call schedules the rebuild of the spare for the next tick: let that happen (WARM still off), then start clean.
const settle = async () => {
  await new Promise((r) => setImmediate(r));
  discardJudge();
};
const act = { label: "Create event", tool: "x", input: {} };
const input = { source: "chat" as const, description: "Create event Pottery", ownerMessage: "put pottery in my calendar" };

test("task field: an answer for the other task is never accepted", () => {
  const reply = { task: "reply", verdict: "approve" };
  const action = { task: "action", decision: "auto", reason: "ok" };
  assert.equal(forTask("reply", reply), reply);
  assert.equal(forTask("action", action), action);
  assert.equal(forTask("action", reply), undefined);
  assert.equal(forTask("reply", action), undefined);
  for (const bad of [{ verdict: "approve" }, { task: "Reply", verdict: "approve" }, { task: ["reply"] }, null, undefined, "reply", 3]) assert.equal(forTask("reply", bad), undefined, JSON.stringify(bad));
});

test("a reply result is not an action verdict, and an action result is not a reply verdict", async () => {
  const was = settings.warm;
  setWarm(false);
  try {
    // The model answered the wrong job with a valid-looking answer of the other one: fail closed.
    const asReply = rig({ task: "reply", verdict: "approve", decision: "auto", reason: "yes" });
    assert.equal((await judgeAction(input, (p) => runJudge("action", p, asReply.io).then((r) => r?.out))).decision, "ask");
    const asAction = rig({ task: "action", decision: "auto", reason: "yes", verdict: "approve" });
    assert.equal((await judgeReply("yes", act, asAction.io)).verdict, "other");
    // ...while the right task passes
    assert.equal((await judgeAction(input, (p) => runJudge("action", p, asAction.io).then((r) => r?.out))).decision, "auto");
    assert.equal((await judgeReply("yes", act, asReply.io)).verdict, "approve");
  } finally {
    setWarm(was);
  }
});

test("each task states itself first in the prompt", async () => {
  const was = settings.warm;
  setWarm(false);
  try {
    const r = rig({ task: "reply", verdict: "other" });
    await judgeReply("yes", act, r.io);
    await runJudge("action", "p", r.io);
    assert.match(r.prompts[0]!, /^task: reply\n/);
    assert.match(r.prompts[1]!, /^task: action\np/);
  } finally {
    setWarm(was);
  }
});

test("reply task fails closed: anything but an exact enum value is other", async () => {
  for (const out of [undefined, null, {}, { verdict: "APPROVE" }, { verdict: "yes" }, { verdict: ["approve"] }, { verdict: 1 }, { verdict: "approve " }]) assert.equal(parseReply(out).verdict, "other", JSON.stringify(out));
  for (const v of ["approve", "decline", "approve_modified", "other"]) assert.equal(parseReply({ verdict: v }).verdict, v);
  assert.deepEqual(parseReply({ verdict: "approve_modified", changes: [{ field: "a", value: "b" }, { field: 1, value: "x" }, null] }).changes, [{ field: "a", value: "b" }]);
  // no answer at all, a thrown error, a slow answer, an error result
  const was = settings.warm;
  setWarm(false);
  try {
    const throws = { query: (() => { throw new Error("boom"); }) as any };
    assert.equal((await judgeReply("yes", act, throws)).verdict, "other");
    const never = { query: (async function* () { await new Promise(() => {}); }) as any };
    assert.equal((await judgeReply("yes", act, never, 20)).verdict, "other");
    const failed = { query: (async function* () { yield { type: "result", subtype: "error_max_turns", is_error: true }; }) as any };
    assert.equal((await judgeReply("yes", act, failed)).verdict, "other");
    const empty = { query: (async function* () {}) as any };
    assert.equal((await judgeReply("yes", act, empty)).verdict, "other");
    assert.equal((await judgeReply("y".repeat(201), act, rig({ task: "reply", verdict: "approve" }).io)).verdict, "other"); // too long for a reply
  } finally {
    setWarm(was);
  }
});

test("action task fails closed: anything but an exact auto is ask", async () => {
  for (const out of [undefined, null, {}, { decision: "AUTO" }, { decision: "auto " }, { decision: true }, { decision: ["auto"] }, { reason: "auto" }]) assert.equal(parseVerdict(out).decision, "ask", JSON.stringify(out));
  assert.equal(parseVerdict({ decision: "auto", reason: "ok" }).decision, "auto");
  const was = settings.warm;
  setWarm(false);
  try {
    const real = (io: any, ms?: number) => judgeAction(input, (p) => runJudge("action", p, io).then((r) => r?.out), ms);
    const failed = { query: (async function* () { yield { type: "result", subtype: "error_during_execution", is_error: true, structured_output: { task: "action", decision: "auto", reason: "x" } }; }) as any };
    assert.equal((await real(failed)).decision, "ask"); // an error result is never read, whatever it carries
    assert.equal((await real({ query: (() => { throw new Error("boom"); }) as any })).decision, "ask");
    assert.equal((await real({ query: (async function* () { await new Promise(() => {}); }) as any }, 20)).decision, "ask");
    assert.equal((await real({ query: (async function* () {}) as any })).decision, "ask");
    assert.equal((await real(rig({ decision: "auto", reason: "no task" }).io)).decision, "ask"); // no task field
  } finally {
    setWarm(was);
  }
});

test("withTimeout: the answer if it is in time, undefined if not", async () => {
  assert.equal(await withTimeout(Promise.resolve(1), 1000), 1);
  assert.equal(await withTimeout(new Promise(() => {}), 10), undefined);
});

test("one spare serves both tasks: a prepared spare is used by whichever comes first, and used up", async () => {
  await settle();
  const was = settings.warm;
  setWarm(true);
  try {
    // reply first
    const r = rig({ task: "reply", verdict: "approve" });
    prepareJudge(r.io);
    prepareJudge(r.io); // already warm: still one process
    assert.equal(r.started(), 1);
    assert.equal((await judgeReply("yes", act, r.io)).verdict, "approve");
    assert.deepEqual(r.log, ["warm1"]);
    assert.equal((await judgeReply("yes", act, r.io)).verdict, "approve"); // used up: cold, and a reply does not rebuild
    assert.deepEqual(r.log, ["warm1", "cold"]);
    assert.equal(r.started(), 1);
    discardJudge();

    // action first, then the rebuilt spare is there for the next action or for a reply
    const a = rig({ task: "action", decision: "ask", reason: "r" });
    prepareJudge(a.io);
    await runJudge("action", "p", a.io);
    await new Promise((res) => setImmediate(res)); // the rebuild after use
    assert.equal(a.started(), 2);
    const b = await runJudge("action", "p", a.io);
    assert.equal(b?.warm, true);
    assert.deepEqual(a.log, ["warm1", "warm2"]);
    await new Promise((res) => setImmediate(res));
    assert.equal(a.started(), 3);
    // a reply takes the spare the action rebuilt (the answer is for the wrong task here: only the process matters)
    await runJudge("reply", "p", a.io);
    assert.deepEqual(a.log, ["warm1", "warm2", "warm3"]);
    assert.equal(a.started(), 3); // and a reply does not rebuild
    discardJudge();
  } finally {
    setWarm(was);
  }
});

test("one spare: WARM=off starts none for either task; a dead spare falls back to cold", async () => {
  await settle();
  const was = settings.warm;
  try {
    setWarm(false);
    const r = rig({ task: "action", decision: "ask", reason: "r" });
    prepareJudge(r.io);
    await runJudge("action", "p", r.io);
    await new Promise((res) => setImmediate(res));
    assert.equal(r.started(), 0);
    assert.deepEqual(r.log, ["cold"]);

    setWarm(true);
    const log: string[] = [];
    const prompts: string[] = [];
    const dead = {
      start: (async () => ({ query: () => { throw new Error("ProcessTransport is not ready for writing"); }, close() {} })) as any,
      query: ((a: { prompt: string }) => one(result({ task: "reply", verdict: "decline" }), log, "cold", prompts, a.prompt)) as any,
    };
    prepareJudge(dead);
    assert.equal((await judgeReply("no", act, dead)).verdict, "decline");
    assert.deepEqual(log, ["cold"]);
    discardJudge();
  } finally {
    setWarm(was);
  }
});
