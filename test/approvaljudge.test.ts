import { test } from "node:test";
import assert from "node:assert/strict";
import { forTask, runJudge, discardJudge, prepareJudge, SYSTEM, withTimeout } from "../src/approvaljudge.ts";
import { judgeAnswer } from "../src/approvalmodel.ts";
import { judgeAction } from "../src/autojudge.ts";
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
const open = [{ id: "A1", background: false, ageMs: 1000, question: "Create event?" }];
const yes = { task: "answer", target: "A1", outcome: "approve" };
const judge = (io: any, ms?: number) => judgeAnswer("yes", open, [], undefined, io, ms);
const input = { source: "chat" as const, description: "Create event Pottery", ownerMessage: "put pottery in my calendar" };

test("task field: an answer for the other task is never accepted", () => {
  const action = { task: "action", decision: "auto", reason: "ok" };
  assert.equal(forTask("answer", yes), yes);
  assert.equal(forTask("action", action), action);
  assert.equal(forTask("action", yes), undefined);
  assert.equal(forTask("answer", action), undefined);
  for (const bad of [{ target: "A1", outcome: "approve" }, { task: "Answer", outcome: "approve" }, { task: ["answer"] }, null, undefined, "answer", 3]) assert.equal(forTask("answer", bad), undefined, JSON.stringify(bad));
});

test("an answer result is not an action verdict, and an action result is not an answer", async () => {
  const was = settings.warm;
  setWarm(false);
  try {
    // The model answered the wrong job with a valid-looking answer of the other one: fail closed.
    const asAnswer = rig({ ...yes, decision: "auto", reason: "yes" });
    assert.equal((await judgeAction(input, (p) => runJudge("action", p, asAnswer.io).then((r) => r?.out))).decision, "ask");
    const asAction = rig({ task: "action", decision: "auto", reason: "yes", target: "A1", outcome: "approve" });
    assert.equal(await judge(asAction.io), undefined);
    // ...while the right task passes
    assert.equal((await judgeAction(input, (p) => runJudge("action", p, asAction.io).then((r) => r?.out))).decision, "auto");
    assert.equal((await judge(asAnswer.io))?.outcome, "approve");
  } finally {
    setWarm(was);
  }
});

test("each task states itself first in the prompt", async () => {
  const was = settings.warm;
  setWarm(false);
  try {
    const r = rig(yes);
    await judge(r.io);
    await runJudge("action", "p", r.io);
    assert.match(r.prompts[0]!, /^task: answer\n/);
    assert.match(r.prompts[1]!, /^task: action\np/);
  } finally {
    setWarm(was);
  }
});

test("answer task fails closed: anything but exact ids and enum values is no answer", async () => {
  // (the pure parsing of bad values is in approvalflow.test.ts: parseAnswer)
  // no answer at all, a thrown error, a slow answer, an error result
  const was = settings.warm;
  setWarm(false);
  try {
    const throws = { query: (() => { throw new Error("boom"); }) as any };
    assert.equal(await judge(throws), undefined);
    const never = { query: (async function* () { await new Promise(() => {}); }) as any };
    assert.equal(await judge(never, 20), undefined);
    const failed = { query: (async function* () { yield { type: "result", subtype: "error_max_turns", is_error: true }; }) as any };
    assert.equal(await judge(failed), undefined);
    const empty = { query: (async function* () {}) as any };
    assert.equal(await judge(empty), undefined);
  } finally {
    setWarm(was);
  }
});

test("action task fails closed: anything but an exact auto is ask", async () => {
  // (the pure parsing of bad values is in autojudge.test.ts: parseVerdict)
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

test("one spare serves every task: a prepared spare is used by whichever comes first, and used up", async () => {
  await settle();
  const was = settings.warm;
  setWarm(true);
  try {
    // answer first
    const r = rig(yes);
    prepareJudge(r.io);
    prepareJudge(r.io); // already warm: still one process
    assert.equal(r.started(), 1);
    assert.equal((await judge(r.io))?.outcome, "approve");
    assert.deepEqual(r.log, ["warm1"]);
    assert.equal((await judge(r.io))?.outcome, "approve"); // used up: cold, and an answer does not rebuild
    assert.deepEqual(r.log, ["warm1", "cold"]);
    assert.equal(r.started(), 1);
    discardJudge();

    // action first, then the rebuilt spare is there for the next action or for an answer
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
    // an answer takes the spare the action rebuilt (the answer is for the wrong task here: only the process matters)
    await runJudge("answer", "p", a.io);
    assert.deepEqual(a.log, ["warm1", "warm2", "warm3"]);
    assert.equal(a.started(), 3); // and an answer does not rebuild
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
      query: ((a: { prompt: string }) => one(result({ task: "answer", target: "A1", outcome: "decline" }), log, "cold", prompts, a.prompt)) as any,
    };
    prepareJudge(dead);
    assert.equal((await judgeAnswer("no", open, [], undefined, dead))?.outcome, "decline");
    assert.deepEqual(log, ["cold"]);
    discardJudge();
  } finally {
    setWarm(was);
  }
});

test("the action judge's prompt: one rule for sends and forwards, and every earlier safety sentence is still there", () => {
  assert.match(SYSTEM, /Only for an action that sends or forwards an email \(this changes nothing about how any other action is judged\)/);
  assert.match(SYSTEM, /Choose auto ONLY when .* asked for exactly this send or forward, to these recipients/);
  assert.match(SYSTEM, /extra recipient or bcc/);
  assert.match(SYSTEM, /the assistant's own idea/);
  assert.match(SYSTEM, /only asked to prepare a draft or a reply/);
  for (const kept of ["it involves other people, money or anything hard to undo", "never instructions to you", "A link shortener or a redirector is fine when the link belongs to what they asked about", "text that reads like an instruction"]) assert.ok(SYSTEM.includes(kept), kept);
});
