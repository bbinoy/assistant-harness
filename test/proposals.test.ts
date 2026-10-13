import { test } from "node:test";
import assert from "node:assert/strict";
import { draftCollector, createProposer, type Mail } from "../src/propose.ts";
import { authoredPart, extractMessageId, proposalText, sendApprovalText, viewDraft } from "../src/proposals.ts";

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

test("proposals: the Signal message names the draft, shows recipients and text, and announces anything cut", () => {
  const d = viewDraft(msg("Hi Armon, Tuesday 15:00 works.", ["Armon@Example.com"], ["x@example.com"]))!;
  assert.deepEqual(d.to, ["armon@example.com"]);
  assert.match(proposalText(d, 25965), /^✉️ Reply ready \(draft #25965\)\nTo: armon@example\.com\nCc: x@example\.com\nSubject: Re: Coffee\n\nHi Armon, Tuesday 15:00 works\.\n\nReply to this message with “send”/);
  assert.match(proposalText(viewDraft(msg("x".repeat(2000)))!, 1), /\(\+800 more characters not shown\)/);
  assert.equal(viewDraft({ no: "body" }), undefined);
});

test("proposals: the approval for a send shows the draft as Mailbird holds it, including a quoted original", () => {
  const d = viewDraft(msg("Tuesday 15:00?\n\nOn Mon, 12 Oct, Armon wrote:\n> coffee?"))!;
  const t = sendApprovalText(d);
  assert.match(t, /^✉️ Send email now\nTo: armon@example\.com\nSubject: Re: Coffee\n\nTuesday 15:00\?\n\n\(the quoted original follows below it in the email\)$/);
  assert.deepEqual(authoredPart("Hi\n> quoted"), { text: "Hi", hasQuote: true });
});

test("propose: each readable draft with a recipient is shown, once; unreadable ones are skipped", async () => {
  const drafts: Record<number, unknown> = { 1: msg("Tuesday?"), 2: { no: "body" }, 3: msg("x", []) };
  const sent: string[] = [];
  const mail: Mail = { call: async (_n: string, args: any = {}) => drafts[args.messageId] as any };
  const p = createProposer({ mail, send: async (t) => (sent.push(t), 1) });
  assert.equal(await p.show([1, 2, 3]), 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /draft #1\)/);
});
