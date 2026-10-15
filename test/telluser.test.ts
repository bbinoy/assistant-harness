import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptions } from "../src/agent.ts";
import { createPipeline, group, owner } from "../src/conversation.ts";
import { createOutbound } from "../src/outbound.ts";
import { classify } from "../src/policy.ts";
import { flagFor } from "../src/toolmanifest.ts";
import { OWNER_TELL, withTell } from "../src/telluser.ts";
import type { TellSink } from "../src/telluser.ts";

// tell_user: the model's own way to say something while it works. Text before a tool call is never sent.

const TOOL = "mcp__tell__tell_user";

test("tell_user: allowed without approval in the owner's chat and in groups, denied for every unattended source", () => {
  assert.equal(flagFor(TOOL, "chat"), "no");
  assert.equal(classify(TOOL, { message: "On it." }, "chat"), "allow");
  assert.equal(classify(TOOL, { message: "On it." }, "group"), "allow");
  for (const source of ["brief", "radar", "handler", "heartbeat", "dream", "browse", "background"] as const) {
    assert.equal(flagFor(TOOL, source), undefined, source);
    assert.equal(classify(TOOL, { message: "x" }, source), "deny", source);
  }
});

test("tell_user: only chat and group runs are given the tool server", () => {
  const base = { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 };
  const has = (o: Parameters<typeof buildOptions>[1]) => Object.keys(buildOptions(async () => ({ approved: true }), o, undefined).mcpServers ?? {}).includes("tell");
  assert.equal(has({ ...base, source: "chat", memory: { dir: "/tmp/n" } }), true);
  assert.equal(has({ ...base, source: "group", memory: { dir: "/tmp/n", groupId: "g1" } }), true);
  for (const source of ["brief", "radar", "handler", "background", "dream"] as const) assert.equal(has({ ...base, source }), false, source);
});

test("tell_user: the sink is found by conversation while the turn runs, and only then", async () => {
  const sink: TellSink = async () => "ok";
  await withTell("g-x", sink, async () => void 0);
  await withTell(OWNER_TELL, undefined, async () => void 0);
});

function rig() {
  const sent: { text: string; quote?: unknown; groupId?: string }[] = [];
  const typing: boolean[] = [];
  const signal = {
    separateAccount: false,
    react: async () => {},
    typing: async (stop = false) => void typing.push(stop),
    markRead: async () => {},
    send: async (t: string, o: { quote?: unknown; groupId?: string } = {}) => (sent.push({ text: t, quote: o.quote, groupId: o.groupId }), sent.length),
  };
  const record = () => {};
  const pipeline = createPipeline({
    signal: signal as any,
    out: createOutbound(signal as any, record),
    record,
    account: "+1",
    runOwner: async () => ({ text: "" }),
    picture: async () => assert.fail("no picture"),
    transcript: async () => "",
    speech: { ready: () => false, synth: async () => "", foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => true,
    admitGroup: async () => {},
    wait: async () => {},
  });
  return { sent, typing, pipeline };
}

test("tell_user: the message goes out before the answer as plain text; silence, empty and markers send nothing extra; typing resumes", async () => {
  const { sent, typing, pipeline } = rig();
  const told: string[] = [];
  const res = await pipeline.runTurn(owner(), {
    announce: false,
    run: async (h) => {
      told.push(await h.tell!("[[silent]]"), await h.tell!("   "));
      told.push(await h.tell!("[[voice]]Sure, researching now."));
      told.push(await h.tell!("[[react: 👍]] Still looking."));
      told.push(await h.tell!("And a third, no cap."));
      return { text: "The result." };
    },
  });
  assert.deepEqual(sent.map((s) => s.text), ["Sure, researching now.", "Still looking.", "And a third, no cap.", "The result."]);
  assert.deepEqual(told.slice(0, 2), ["Nothing to send.", "Nothing to send."]);
  assert.match(told[2]!, /^Sent/);
  assert.equal(res.spoke, true);
  assert.equal(typing.filter((s) => !s).length >= 4, true); // shown at the start, again after each message
  assert.equal(typing[typing.length - 1], true); // and stopped at the end
});

test("tell_user: a group turn sends it to that group", async () => {
  const { sent, pipeline } = rig();
  await pipeline.runTurn(group("g1"), { announce: false, run: async (h) => (await h.tell!("Checking that for you."), { text: "[[silent]]" }) });
  assert.deepEqual(sent.map((s) => [s.text, s.groupId]), [["Checking that for you.", "g1"]]);
});

test("tell_user: a reaction or wake-up turn is given no way to tell", async () => {
  const { pipeline } = rig();
  for (const kind of [{ reaction: true }, { background: true }]) {
    let hook: unknown = "unset";
    await pipeline.runTurn(owner(), { announce: false, ...kind, run: async (h) => ((hook = h.tell), { text: "" }) });
    assert.equal(hook, undefined);
  }
});
