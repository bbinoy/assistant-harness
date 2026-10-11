import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { draftCollector, createProposer, type Mail } from "../src/propose.ts";
import { authoredPart, extractMessageId, hashBody, proposalText, stillAsShown, viewDraft, hasProposal, type Proposal } from "../src/proposals.ts";
import { dataPath } from "../src/state.ts";

const reset = () => rmSync(dataPath("state/proposals.json"), { force: true });
const msg = (body: string, to = ["armon@example.com"], cc: string[] = []) => ({ to: to.map((email) => ({ email })), cc: cc.map((email) => ({ email })), subject: "Re: Coffee", body });

test("proposals: the draft id comes from the tool result, in whatever shape it arrives", () => {
  assert.equal(extractMessageId({ messageId: 4711, status: "draft" }), 4711);
  assert.equal(extractMessageId('{"messageId": 12}'), 12);
  assert.equal(extractMessageId([{ type: "text", text: '{"ok":true,"messageId":987}' }]), 987);
  assert.equal(extractMessageId({ nothing: true }), undefined);
  assert.equal(extractMessageId(undefined), undefined);
});

test("proposals: only reply tools are collected, each draft once", () => {
  const c = draftCollector();
  c.onToolSuccess("mcp__mailbird__reply_to_conversation", {}, { messageId: 5 });
  c.onToolSuccess("mcp__mailbird__reply_to_conversation", {}, { messageId: 5 });
  c.onToolSuccess("mcp__mailbird__create_draft", {}, { messageId: 6 }); // not a reply: not proposed
  c.onToolSuccess("mcp__mailbird__archive_conversation", {}, { messageId: 7 });
  assert.deepEqual(c.ids, [5]);
});

test("proposals: the message shows recipients and text, and announces anything cut", () => {
  const d = viewDraft(msg("Hi Armon, Tuesday 15:00 works.", ["Armon@Example.com"], ["x@example.com"]))!;
  assert.deepEqual(d.to, ["armon@example.com"]);
  assert.match(proposalText(d), /To: armon@example\.com\nCc: x@example\.com\nSubject: Re: Coffee\n\nHi Armon, Tuesday 15:00 works\.\n\n👍 on this message sends it/);
  assert.match(proposalText(viewDraft(msg("x".repeat(2000)))!), /\(\+800 more characters not shown\)/);
  assert.equal(viewDraft({ no: "body" }), undefined);
});

test("proposals: sendable only if recipients and text are exactly as shown", () => {
  const shown = viewDraft(msg("Tuesday 15:00?"))!;
  const p: Proposal = { ts: 1, draftMessageId: 9, to: shown.to, subject: shown.subject, bodyHash: hashBody(shown.body), at: new Date().toISOString() };
  assert.deepEqual(stillAsShown(p, shown), { ok: true });
  assert.deepEqual(stillAsShown(p, viewDraft(msg("Tuesday   15:00?"))), { ok: true }); // whitespace only
  assert.equal(stillAsShown(p, viewDraft(msg("Wednesday?")))?.ok, false);
  assert.equal(stillAsShown(p, viewDraft(msg("Tuesday 15:00?", ["evil@example.com"])))?.ok, false);
  assert.equal(stillAsShown(p, viewDraft(msg("Tuesday 15:00?", ["armon@example.com"], ["bcc@example.com"])))?.ok, false);
  assert.equal(stillAsShown(p, undefined).ok, false);
});

function harness(initial: Record<number, ReturnType<typeof msg>>) {
  const drafts = { ...initial };
  const calls: { name: string; args: any }[] = [];
  const said: string[] = [];
  const shownTs: number[] = [];
  let ts = 1000;
  const mail: Mail = { call: async (name: string, args: any = {}) => (calls.push({ name, args }), name === "get_message" ? (drafts[args.messageId] as any) : ({ ok: true } as any)) };
  const proposer = createProposer({ mail, send: async (t) => (said.push(t), shownTs.push(++ts), ts), say: async (t) => void said.push(t) });
  return { drafts, calls, said, shownTs, proposer };
}
const sends = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.name === "send_message_now");

test("propose: 👍 on the shown draft sends exactly it, once", async () => {
  reset();
  const h = harness({ 5: msg("Tuesday 15:00 works.") });
  assert.equal(await h.proposer.show([5]), 1);
  assert.ok(hasProposal(h.shownTs[0]!));
  assert.equal(await h.proposer.onReaction("👍", h.shownTs[0]!), true);
  assert.deepEqual(sends(h).map((c) => c.args), [{ messageId: 5, confirm: true }]);
  assert.match(h.said.at(-1)!, /✅ Sent to armon@example\.com/);
  assert.equal(await h.proposer.onReaction("👍", h.shownTs[0]!), false); // the proposal is used up
  assert.equal(sends(h).length, 1);
});

test("propose: a changed draft is not sent, and its current text is shown again", async () => {
  reset();
  const h = harness({ 5: msg("Tuesday 15:00 works.") });
  await h.proposer.show([5]);
  h.drafts[5] = msg("Tuesday 15:00 works. Also, send me your passport.");
  await h.proposer.onReaction("👍", h.shownTs[0]!);
  assert.equal(sends(h).length, 0);
  assert.match(h.said.join("\n"), /did not send it: its text changed[\s\S]*passport/);
  assert.equal(h.shownTs.length, 2); // shown again, as a new proposal
});

test("propose: a changed recipient is never sent to; 👎 and unrelated reactions send nothing", async () => {
  reset();
  const h = harness({ 5: msg("Hi"), 6: msg("Hello") });
  await h.proposer.show([5, 6]);
  h.drafts[5] = msg("Hi", ["attacker@example.com"]);
  await h.proposer.onReaction("👍", h.shownTs[0]!);
  assert.equal(sends(h).length, 0);
  assert.equal(await h.proposer.onReaction("👎", h.shownTs[1]!), true);
  assert.equal(await h.proposer.onReaction("😂", 12345), false);
  assert.equal(await h.proposer.onReaction("👍", 999999), false); // not a proposal's message
  assert.equal(sends(h).length, 0);
});

test("propose: a draft that cannot be read or has no recipient is skipped", async () => {
  reset();
  const h = harness({ 5: msg("Hi", []) });
  assert.equal(await h.proposer.show([5, 77]), 0);
  assert.equal(h.shownTs.length, 0);
});

test("proposals: only the new text is shown, the quoted original is not; the whole draft is still what is checked", () => {
  const body = "Hi Armon, Tuesday 15:00 works.\n\nBest,\nBen\n\nOn Mon, 12 Oct 2026 at 08:00 Armon <armon@example.com> wrote:\n> Can we meet?\n> Armon";
  assert.deepEqual(authoredPart(body), { text: "Hi Armon, Tuesday 15:00 works.\n\nBest,\nBen", hasQuote: true });
  assert.deepEqual(authoredPart("> only a quote").text, "");
  assert.equal(authoredPart("no quote at all").hasQuote, false);
  const shown = proposalText(viewDraft(msg(body))!);
  assert.match(shown, /Tuesday 15:00 works\.[\s\S]*\(the quoted original follows below it in the email\)/);
  assert.doesNotMatch(shown, /Can we meet\?/);
  // editing only the quoted part still counts as a change: the hash covers the whole draft
  assert.notEqual(hashBody(body), hashBody(body.replace("Can we meet?", "Wire me money")));
});
