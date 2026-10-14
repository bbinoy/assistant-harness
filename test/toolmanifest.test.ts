import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, type Source } from "../src/audit.ts";
import { classify } from "../src/policy.ts";
import { settings } from "../src/settings.ts";
import { actionOf, entryFor, flagFor, MAIL_PROVIDERS, MANIFEST, mailView, type Flag } from "../src/toolmanifest.ts";

const MB = "mcp__mailbird__";
const GM = "mcp__claude_ai_Gmail__";
const CAL = "mcp__claude_ai_Google_Calendar__";
const N = "mcp__claude_ai_Notion__";

test("manifest: a tool name appears in one entry only, and every entry names a provider and an action", () => {
  const names = MANIFEST.map((e) => e.tool);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
  for (const e of MANIFEST) {
    assert.ok(e.provider && e.action && e.flag, e.tool);
    assert.ok(e.view === undefined || MAIL_PROVIDERS.includes(e.provider), `${e.tool}: only mail tools have a mail view`);
  }
});

// The flag a source gets, spelled out by hand here so that a change to the manifest's rules shows up as a failing line.
const want = (spec: Flag | Partial<Record<string, Flag>>, source: Source): Flag => (typeof spec === "string" ? spec : (spec[source] ?? (source === "chat" ? undefined : spec.unattended) ?? "yes"));

test("manifest: every entry classifies as its flag says, for every source (the active mail provider only)", () => {
  for (const e of MANIFEST) {
    if (MAIL_PROVIDERS.includes(e.provider) && e.provider !== settings.mailProvider) continue;
    for (const source of SOURCES) {
      if (source === "group") continue; // a group has its own rules (below)
      const flag = e.only && !e.only.includes(source) ? undefined : want(e.flag, source);
      assert.equal(flagFor(e.tool, source), flag, `${e.tool} (${source})`);
      assert.equal(actionOf(e.tool), e.action, e.tool);
      // Read/Write/Edit also need a path inside the notes: with none the file rule denies first
      if (e.provider === "builtin" && e.action === "note-file") continue;
      assert.equal(classify(e.tool, {}, source), flag === undefined ? "deny" : flag === "no" ? "allow" : "ask", `${e.tool} (${source})`);
    }
  }
});

test("manifest: the defaults the owner decided, tool by tool: [chat, handler, brief]", () => {
  const table: Record<string, [Flag, Flag, Flag]> = {
    [`${MB}get_message`]: ["no", "no", "no"],
    [`${MB}create_draft`]: ["no", "yes", "no"],
    [`${MB}update_draft`]: ["no", "yes", "no"],
    [`${MB}reply_to_conversation`]: ["no", "no", "no"], // an in-thread reply is a DRAFT in Mailbird
    [`${MB}reply_all_to_conversation`]: ["no", "no", "no"],
    [`${MB}archive_conversation`]: ["no", "yes", "no"],
    [`${MB}select_conversation`]: ["no", "yes", "no"],
    [`${MB}send_self_briefing`]: ["no", "yes", "no"],
    [`${MB}send_message_now`]: ["auto", "yes", "yes"],
    [`${MB}forward_conversation`]: ["no", "yes", "no"],
    [`${CAL}list_events`]: ["no", "no", "no"],
    [`${CAL}create_event`]: ["auto", "auto", "auto"],
    [`${CAL}update_event`]: ["auto", "yes", "yes"],
    [`${CAL}respond_to_event`]: ["yes", "yes", "yes"],
    "mcp__claude_ai_Google_Drive__share_file": ["yes", "yes", "yes"],
    [`${N}notion-create-pages`]: ["no", "yes", "no"],
    [`${N}notion-update-page`]: ["no", "yes", "no"],
    [`${N}notion-create-comment`]: ["yes", "yes", "yes"],
    WebSearch: ["no", "no" as Flag, "no"], // handler/brief: see `only` below
    Skill: ["no", "no", "no"],
  };
  for (const [tool, [chat, handler, brief]] of Object.entries(table)) {
    assert.equal(flagFor(tool, "chat"), chat, `${tool} chat`);
    if (tool === "WebSearch") continue;
    assert.equal(flagFor(tool, "handler"), handler, `${tool} handler`);
    assert.equal(flagFor(tool, "brief"), brief, `${tool} brief`);
  }
  // web: search in chat and background only; a page is judged for the owner's own runs and never for the mail handler
  assert.deepEqual((["chat", "background", "brief", "handler"] as const).map((s) => flagFor("WebSearch", s)), ["no", "no", undefined, undefined]);
  assert.deepEqual((["chat", "background", "brief", "radar", "handler", "heartbeat"] as const).map((s) => flagFor("WebFetch", s)), ["auto", "auto", "auto", "auto", undefined, undefined]);
});

test("manifest: unknown tools default to yes (ask), unless the name is a read verb", () => {
  for (const source of SOURCES) if (source !== "group") assert.equal(flagFor("mcp__new_server__do_something", source), "yes", source);
  assert.equal(flagFor("Bash", "chat"), "yes");
  assert.equal(classify("mcp__new_server__do_something", {}, "chat"), "ask");
  assert.equal(flagFor("mcp__new_server__get_thing", "chat"), "no");
  assert.equal(actionOf("mcp__x__send_search"), "unknown");
});

test("manifest: a provider's entries take effect only while it is the active mail provider", () => {
  const gmailEntries = MANIFEST.filter((e) => e.provider === "gmail");
  const mailbirdEntries = MANIFEST.filter((e) => e.provider === "mailbird");
  assert.ok(gmailEntries.length > 5 && mailbirdEntries.length > 10);
  for (const e of gmailEntries) {
    assert.equal(entryFor(e.tool, "mailbird"), undefined, `${e.tool} must not leak into mailbird mode`);
    assert.equal(entryFor(e.tool, "none"), undefined, e.tool);
    assert.equal(entryFor(e.tool, "gmail")?.provider, "gmail", e.tool);
  }
  for (const e of mailbirdEntries) {
    assert.equal(entryFor(e.tool, "gmail"), undefined, `${e.tool} must not leak into gmail mode`);
    assert.equal(entryFor(e.tool, "mailbird")?.provider, "mailbird", e.tool);
  }
  // a Gmail send in mailbird mode is just an unknown tool: asks, and no mail view
  assert.equal(flagFor(`${GM}send_message`, "chat", "mailbird"), "yes");
  assert.equal(mailView(`${GM}send_message`, { to: ["a@example.com"] }, undefined, "mailbird"), undefined);
  assert.equal(mailView(`${MB}create_draft`, { to: [{ email: "a@example.com" }] }, undefined, "gmail"), undefined);
  // ...and with gmail active the same rule holds as for Mailbird: sends are judged in chat, asked everywhere else
  assert.equal(flagFor(`${GM}send_message`, "chat", "gmail"), "auto");
  assert.equal(flagFor(`${GM}send_message`, "handler", "gmail"), "yes");
  assert.equal(flagFor(`${GM}reply`, "radar", "gmail"), "yes");
  assert.equal(flagFor(`${GM}forward`, "brief", "gmail"), "yes");
  assert.equal(flagFor(`${GM}create_draft`, "chat", "gmail"), "no");
  assert.equal(flagFor(`${GM}search_threads`, "handler", "gmail"), "no");
});

test("manifest: same action, same behaviour across mail providers", () => {
  const by = (provider: string, action: string) => MANIFEST.filter((e) => e.provider === provider && e.action === action).map((e) => JSON.stringify(e.flag));
  for (const action of ["send", "forward", "draft", "read", "archive"]) {
    const a = new Set([...by("mailbird", action), ...by("gmail", action)]);
    assert.equal(a.size, 1, action);
  }
});

test("manifest: every Mailbird tool the model is given by default has an entry", () => {
  for (const t of settings.mailbirdTools) assert.ok(entryFor(`${MB}${t}`, "mailbird"), t);
});

test("manifest: the group's rules are not flags and stay as they were", () => {
  const dir = "/nonexistent-group-dir";
  assert.equal(classify("WebSearch", { query: "x" }, "group"), "allow");
  assert.equal(classify("WebFetch", { url: "https://example.com" }, "group"), "deny");
  assert.equal(classify(`${MB}send_message_now`, {}, "group"), "deny");
  assert.equal(classify(`${CAL}create_event`, {}, "group"), "deny");
  assert.equal(classify("Read", { file_path: `${dir}/x.md` }, "group"), "deny");
});

test("mailView: Mailbird send reads its draft back; bcc and attachments are always in the view", () => {
  const draft = { to: ["a@example.com"], cc: [], bcc: ["spy@example.com"], subject: "Hi", body: "text", hasAttachments: true };
  assert.deepEqual(mailView(`${MB}send_message_now`, { messageId: 5, confirm: true }, draft), { action: "send", ...draft });
  assert.equal(mailView(`${MB}send_message_now`, { messageId: 5, confirm: true }), undefined); // no draft read back: no view
});

test("mailView: Mailbird forward and reply tools, and create/update draft", () => {
  assert.deepEqual(mailView(`${MB}forward_conversation`, { conversationId: "g", body: "FYI" }), { action: "forward", to: [], cc: [], bcc: [], subject: "", body: "FYI", hasAttachments: false });
  assert.equal(mailView(`${MB}reply_to_conversation`, { conversationId: "g", body: "ok" })?.action, "draft");
  const d = mailView(`${MB}create_draft`, { accountId: 1, to: [{ email: "A@Example.com", name: "A" }], bcc: [{ email: "b@example.com" }], subject: "S", body: "B", attachments: ["mailbird://x"] });
  assert.deepEqual(d, { action: "draft", to: ["a@example.com"], cc: [], bcc: ["b@example.com"], subject: "S", body: "B", hasAttachments: true });
});

test("mailView: the Gmail connector's send, reply, forward and drafts normalise to the same view", () => {
  const v = (tool: string, input: Record<string, unknown>) => mailView(`${GM}${tool}`, input, undefined, "gmail");
  assert.deepEqual(v("send_message", { to: ["A@example.com"], cc: ["c@example.com"], bcc: ["b@example.com"], subject: "S", body: "B", attachments: [{ content: "eA==", filename: "f.txt" }] }), {
    action: "send", to: ["a@example.com"], cc: ["c@example.com"], bcc: ["b@example.com"], subject: "S", body: "B", hasAttachments: true,
  });
  assert.equal(v("send_message", { draftId: "r1" }), undefined); // a draft nobody read back cannot be shown
  assert.deepEqual(v("reply", { messageId: "m", to: ["a@example.com"], bcc: ["b@example.com"], htmlBody: "<p>hi</p>" }), {
    action: "reply", to: ["a@example.com"], cc: [], bcc: ["b@example.com"], subject: "", body: "<p>hi</p>", hasAttachments: false,
  });
  assert.deepEqual(v("forward", { messageId: "m", to: ["x@example.com"], forwardText: "FYI", bcc: ["b@example.com"] }), {
    action: "forward", to: ["x@example.com"], cc: [], bcc: ["b@example.com"], subject: "", body: "FYI", hasAttachments: false,
  });
  assert.equal(v("create_draft", { to: ["a@example.com"], subject: "S", body: "B" })?.action, "draft");
  assert.equal(v("update_draft", { draftId: "d", bcc: ["b@example.com"] })?.bcc[0], "b@example.com");
  assert.equal(v("search_threads", { query: "x" }), undefined); // not an outgoing mail
});
