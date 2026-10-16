import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAudit } from "../src/audit.ts";
import type { Verdict } from "../src/autojudge.ts";
import { browse, browseSystem } from "../src/browse.ts";
import { BrowseGuard } from "../src/browseguard.ts";
import { findTotal, parseSnapshot } from "../src/browserules.ts";
import { hostMatches, normalizeDomain, registeredDomain } from "../src/domains.ts";
import { makeCanUseTool } from "../src/permissions.ts";
import { loadProfile, ProfileError, ProfileStore, seal, unseal, fieldFitsKey, kindOfKey, type Entries, type Keychain } from "../src/profile.ts";
import { profileCli } from "../src/profilecli.ts";
import { factsOf, validateQuestion } from "../src/questionfacts.ts";
import { OWNER_KEY } from "../src/send.ts";

// Obviously fake values only. No test touches the real Keychain: it is a function the store is given.
const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const NAME = "Annabelle Fakename";
const EMAIL = "annabelle.fake@example.com";
const PASSPORT = "ZZ9999999FAKE";
const memoryKeychain = (initial?: string): Keychain & { stored?: string } => {
  const k: Keychain & { stored?: string } = { stored: initial, get: async () => k.stored, set: async (hex) => void (k.stored = hex) };
  return k;
};
const brokenKeychain: Keychain = { get: async () => { throw new Error("the macOS Keychain could not be used"); }, set: async () => { throw new Error("no"); } };
const tmp = () => join(mkdtempSync(join(tmpdir(), "profile-")), "profile.enc");

const ENTRIES: Entries = {
  full_name: { value: NAME, kind: "name", domains: [] },
  email: { value: EMAIL, kind: "email", domains: [] },
  passport: { value: PASSPORT, kind: "id", domains: ["sbb.ch", "trainline.com"] },
  passport_nodomain: { value: PASSPORT, kind: "id", domains: [] },
  passport_other: { value: PASSPORT, kind: "id", domains: ["trainline.com"] },
  loyalty_sbb: { value: "LOYALTY-FAKE-1234", kind: "other", domains: ["sbb.ch"] },
};

// ---- the encrypted file ----

test("encryption: AES-256-GCM round trip; the file holds no plaintext; a wrong key, a changed byte and a changed tag all fail", () => {
  const file = seal(ENTRIES, KEY);
  assert.ok(!file.includes(PASSPORT) && !file.includes(EMAIL) && !file.includes("passport"));
  assert.deepEqual(unseal(file, KEY).email, ENTRIES.email);
  assert.throws(() => unseal(file, OTHER_KEY));
  const o = JSON.parse(file) as { ct: string; tag: string; iv: string };
  const flip = (b64: string) => { const b = Buffer.from(b64, "base64"); b[0] = b[0]! ^ 1; return b.toString("base64"); };
  assert.throws(() => unseal(JSON.stringify({ ...o, ct: flip(o.ct) }), KEY), "a changed ciphertext");
  assert.throws(() => unseal(JSON.stringify({ ...o, tag: flip(o.tag) }), KEY), "a changed tag");
  assert.throws(() => unseal(JSON.stringify({ ...o, iv: flip(o.iv) }), KEY), "a changed nonce");
  assert.throws(() => unseal("not json", KEY));
  assert.notEqual(seal(ENTRIES, KEY), file, "a fresh nonce every time");
});

test("the store: first write creates the key in the keychain and a 0600 file; read gives the entries back", async () => {
  const kc = memoryKeychain();
  const path = tmp();
  const store = new ProfileStore(kc, path);
  assert.equal(store.exists(), false);
  assert.deepEqual(await store.read(), {});
  await store.write(ENTRIES);
  assert.match(kc.stored!, /^[0-9a-f]{64}$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, "utf8").includes(EMAIL));
  assert.deepEqual((await store.read()).passport, ENTRIES.passport);
});

test("fail closed: no keychain, no key for an existing file, a changed file and a loose file mode all mean no profile", async () => {
  const path = tmp();
  await new ProfileStore(memoryKeychain(KEY), path).write(ENTRIES);
  const problems: string[] = [];
  // the keychain cannot be read
  await assert.rejects(new ProfileStore(brokenKeychain, path).read(), ProfileError);
  assert.equal(await loadProfile(new ProfileStore(brokenKeychain, path), (r) => problems.push(r)), undefined);
  assert.match(problems[0]!, /Keychain/);
  // the keychain has no key (or another one)
  await assert.rejects(new ProfileStore(memoryKeychain(), path).read(), /no key/);
  await assert.rejects(new ProfileStore(memoryKeychain(OTHER_KEY), path).read(), /does not open/);
  // a write must not mint a new key over an existing file
  const empty = memoryKeychain();
  await assert.rejects(new ProfileStore(empty, path).write({}), ProfileError);
  assert.equal(empty.stored, undefined);
  // a changed file
  const o = JSON.parse(readFileSync(path, "utf8")) as { ct: string };
  writeFileSync(path, JSON.stringify({ ...o, ct: Buffer.from("xx").toString("base64") }), { mode: 0o600 });
  assert.equal(await loadProfile(new ProfileStore(memoryKeychain(KEY), path)), undefined);
  // a file others can read
  const loose = tmp();
  await new ProfileStore(memoryKeychain(KEY), loose).write(ENTRIES);
  (await import("node:fs")).chmodSync(loose, 0o644);
  await assert.rejects(new ProfileStore(memoryKeychain(KEY), loose).read(), /readable by others/);
});

// ---- the owner's command ----

const cli = async (argv: string[], store: ProfileStore, value = "") => {
  const out: string[] = [];
  const prompts: string[] = [];
  const code = await profileCli(argv, { store, readHidden: async (p) => (prompts.push(p), value), out: (l) => out.push(l) });
  return { code, out: out.join("\n"), prompts };
};

test("the command: set reads a hidden value, list masks it, domains and delete work; values never appear in the output", async () => {
  const store = new ProfileStore(memoryKeychain(), tmp());
  let r = await cli(["set", "passport"], store, PASSPORT);
  assert.equal(r.code, 0);
  assert.match(r.prompts[0]!, /hidden/);
  assert.ok(!r.out.includes(PASSPORT));
  assert.match(r.out, /will not be filled anywhere until you name the sites/, "a sensitive key starts without a site");
  r = await cli(["set", "email"], store, EMAIL);
  assert.equal(r.code, 0);
  r = await cli(["domains", "passport", "https://www.sbb.ch/en,Trainline.com"], store);
  assert.match(r.out, /sbb\.ch, trainline\.com/);
  r = await cli(["list"], store);
  assert.ok(!r.out.includes(PASSPORT) && !r.out.includes(EMAIL), "masked");
  assert.match(r.out, /passport\s+id\s+••••FAKE \(last 4\)\s+sbb\.ch, trainline\.com/);
  assert.match(r.out, /email\s+email\s+an•••\s+any https page/);
  r = await cli(["delete", "passport"], store);
  assert.equal(r.code, 0);
  assert.equal(Object.keys(await store.read()).join(), "email");
});

test("the command refuses a card number, a password field name, a bad key and an empty value; no value as an argument is ever used", async () => {
  const store = new ProfileStore(memoryKeychain(), tmp());
  assert.equal((await cli(["set", "visa"], store, "4111 1111 1111 1111")).code, 1);
  assert.equal((await cli(["set", "bank_password"], store, "hunter2hunter2")).code, 1);
  assert.equal((await cli(["set", "Bad Key"], store, "x")).code, 1);
  assert.equal((await cli(["set", "email"], store, "  ")).code, 1);
  assert.equal(store.exists(), false, "nothing was written");
  assert.equal((await cli(["set", "passport", "--domains", "not a domain"], store, PASSPORT)).code, 1);
  assert.equal((await cli(["nonsense"], store)).code, 1);
  assert.equal((await cli(["list"], new ProfileStore(brokenKeychain, (await (async () => { const p = tmp(); await new ProfileStore(memoryKeychain(KEY), p).write(ENTRIES); return p; })())))).code, 1, "an unreadable keychain is an error, not an empty list");
});

// ---- domains ----

test("registered domains: multi-part suffixes and hosting platforms; a look-alike is a different domain", () => {
  assert.equal(registeredDomain("www.sbb.ch"), "sbb.ch");
  assert.equal(registeredDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registeredDomain("evil.github.io"), "evil.github.io");
  assert.equal(registeredDomain("a.b.trainline.com."), "trainline.com");
  assert.equal(normalizeDomain("https://WWW.SBB.ch/en?x=1"), "sbb.ch");
  assert.equal(normalizeDomain("192.168.1.1"), undefined);
  assert.equal(normalizeDomain("localhost"), undefined);
  assert.ok(hostMatches("tickets.sbb.ch", ["sbb.ch"]));
  assert.ok(!hostMatches("sbb.ch.evil.com", ["sbb.ch"]));
  assert.ok(!hostMatches("notsbb.ch", ["sbb.ch"]));
  assert.ok(!hostMatches("sbb.ch.attacker.io", ["sbb.ch"]));
});

test("key kinds and which field a key fits", () => {
  assert.equal(kindOfKey("email"), "email");
  assert.equal(kindOfKey("passport"), "id");
  assert.equal(kindOfKey("date_of_birth"), "dob");
  assert.equal(kindOfKey("loyalty.sbb"), "other");
  assert.ok(fieldFitsKey("E-mail address", "email", { kind: "email" }));
  assert.ok(!fieldFitsKey("Phone", "email", { kind: "email" }));
  assert.ok(!fieldFitsKey("Username", "full_name", { kind: "name" }));
  assert.ok(fieldFitsKey("Vorname", "first_name", { kind: "name" }));
  assert.ok(fieldFitsKey("SBB loyalty number", "loyalty_sbb", { kind: "other" }));
  assert.ok(!fieldFitsKey("Comments", "loyalty_sbb", { kind: "other" }));
});

test("the total on a page: as the page writes it, or nothing", () => {
  assert.equal(findTotal('- text: Subtotal CHF 40.00\n- text: Total CHF 45.00'), "CHF 45.00");
  assert.equal(findTotal("- generic: Zu zahlen: 1’245.50 €"), "1’245.50 €");
  assert.equal(findTotal("- text: Price from 12.90 EUR"), "12.90 EUR");
  assert.equal(findTotal("- heading \"Book\"\n- text: 3 passengers"), undefined);
});

// ---- the guard ----

const B = "mcp__browser__browser_";
const opts = { signal: new AbortController().signal } as never;
const publicDns = async () => ["93.184.216.34"];
const page = (url: string, extra = "", price = "- text: Total CHF 45.00") => `### Page
- Page URL: ${url}
### Snapshot
\`\`\`yaml
- generic [ref=e2]:
  - form "Passenger" [ref=e3]:
    - textbox "Full name" [ref=e4]
    - textbox "E-mail" [ref=e5]
    - textbox "Passport number" [ref=e6]
    - textbox "Loyalty number" [ref=e7]
    - textbox "Card number" [ref=e8]
    - textbox "Password" [ref=e9]
    - textbox "Comments" [ref=e10]
    - iframe [ref=e11]:
      - textbox "E-mail" [ref=f1e2]
    ${extra}
    ${price}
    - button "Buy ticket" [ref=e12]
\`\`\``;
const SBB = "https://www.sbb.ch/en/booking";
const guard = (profile: { entries: Entries } | undefined = { entries: ENTRIES }, mode: "owner" | "group" = "owner") => new BrowseGuard({ mode, task: "book the 10:00 train for Annabelle", outDir: join(tmpdir(), "nope"), resolver: publicDns, profile });
const onPage = (g: BrowseGuard, url = SBB, text = page(url)) => (g.shape(`${B}snapshot`, {}, text), g);
const fill = (ref: string, key: string) => ({ target: ref, text: `{{profile:${key}}}` });
// What @playwright/mcp echoes after a type: the code it ran, with the value, and a page view with the field's value.
const echo = (url: string, ref: string, label: string, value: string) =>
  `### Ran Playwright code\n\`\`\`js\nawait page.getByRole('textbox', { name: '${label}' }).fill('${value}');\n\`\`\`\n${page(url).replace(new RegExp(`(textbox "${label}" \\[ref=${ref}\\])`), `$1: ${value}`)}`;

test("fill: a matching field is typed with the real value by code; the question text, the call and the result carry the key, never the value", async () => {
  const g = onPage(guard());
  const d = await g.decide(`${B}type`, fill("e5", "email"));
  assert.equal(d.kind, "defer");
  assert.equal(d.input?.text, EMAIL, "the browser gets the real value");
  assert.ok(!d.description!.includes(EMAIL) && /E-mail.*← email/.test(d.description!));
  const shown = g.shape(`${B}type`, d.input!, echo(SBB, "e5", "E-mail", EMAIL));
  assert.ok(shown !== undefined && !shown.includes(EMAIL), "the echo of the typed code and the field value are cut");
  assert.match(shown!, /^Filled “E-mail” from the saved profile\./);
  assert.ok(!shown!.includes("Ran Playwright code"));
  assert.match(shown!, /\[ref=e5\]: \[filled\]/);
  // a later page view, and a page that repeats the value elsewhere, are cut too
  const later = g.shape(`${B}snapshot`, {}, page(SBB, `- text: "Confirmation will go to ${EMAIL}."`).replace('textbox "E-mail" [ref=e5]', `textbox "E-mail" [ref=e5]: ${EMAIL}`));
  assert.ok(later !== undefined && !later.includes(EMAIL) && later.includes("Confirmation will go to [filled]."));
  assert.deepEqual(g.profileKeys().map((k) => k.key).slice(0, 2), ["email", "full_name"]);
});

test("fill: the placeholder cannot go in a card, password or one-time-code field, a field of another kind, a non-field or a frame", async () => {
  const g = onPage(guard());
  const deny = async (input: Record<string, unknown>, re: RegExp) => {
    const d = await onPage(guard()).decide(`${B}type`, input); // a fresh run each time: a run that keeps being refused is stopped
    assert.equal(d.kind, "deny", JSON.stringify(input));
    assert.match(d.reason!, re);
  };
  await deny(fill("e8", "email"), /payment or login field/);
  await deny(fill("e9", "email"), /payment or login field/);
  await deny(fill("e4", "email"), /does not look like the place/);
  await deny(fill("e10", "full_name"), /does not look like the place/);
  await deny(fill("e12", "email"), /not a text field/);
  await deny(fill("f1e2", "email"), /embedded frame/);
  await deny(fill("e5", "no_such_key"), /no saved detail called no_such_key/);
  await deny({ target: "e5", text: "mail {{profile:email}}" }, /whole text/);
  await deny({ target: "e5", text: "{{profile:email}}", submit: true }, /Do not submit/);
  // fill_form: one bad field refuses the whole call
  const f = await g.decide(`${B}fill_form`, { fields: [{ target: "e5", name: "E-mail", type: "textbox", value: "{{profile:email}}" }, { target: "e8", name: "Card number", type: "textbox", value: "{{profile:email}}" }] });
  assert.equal(f.kind, "deny");
  // and a typed card number still always asks, exactly as before
  assert.equal((await g.decide(`${B}type`, { target: "e8", text: "4111111111111111" })).kind, "ask");
});

test("fill: a sensitive key only on its own sites; no site list means nowhere; the match is on the registered domain", async () => {
  const on = async (url: string, key: string) => onPage(guard(), url).decide(`${B}type`, fill("e6", key));
  assert.equal((await on(SBB, "passport")).kind, "defer");
  assert.equal((await on("https://tickets.trainline.com/x", "passport")).kind, "defer");
  assert.match((await on("https://www.example.org/x", "passport")).reason!, /not allowed on www\.example\.org/);
  assert.match((await on("https://sbb.ch.evil.com/x", "passport")).reason!, /not allowed/);
  assert.match((await on(SBB, "passport_other")).reason!, /not allowed on www\.sbb\.ch/);
  assert.match((await on(SBB, "passport_nodomain")).reason!, /not named a site/);
  // a loyalty number is matched on its key words, on its site
  assert.equal((await onPage(guard()).decide(`${B}type`, fill("e7", "loyalty_sbb"))).kind, "defer");
  // a plain key (name, e-mail) goes on any https page
  assert.equal((await onPage(guard(), "https://www.example.org/x").decide(`${B}type`, fill("e5", "email"))).kind, "defer");
});

test("fill: refused on http, before any page view, and after the page changed since the page view", async () => {
  assert.match((await onPage(guard(), "http://www.sbb.ch/en").decide(`${B}type`, fill("e5", "email"))).reason!, /https/);
  assert.match((await guard().decide(`${B}type`, fill("e5", "email"))).reason!, /not in the last page view|No page/);
  const g = onPage(guard());
  // a click went to another address and its result carried no page view with refs
  g.shape(`${B}click`, { target: "e12" }, "### Page\n- Page URL: https://www.sbb.ch/en/other\n### Result\nok");
  assert.match((await g.decide(`${B}type`, fill("e5", "email"))).reason!, /page changed since the last page view/);
  onPage(g, "https://www.sbb.ch/en/other");
  assert.equal((await g.decide(`${B}type`, fill("e5", "email"))).kind, "defer", "a fresh page view allows it again");
});

test("fill: a group's guard has no profile and never types one; the worker is told no keys", async () => {
  const g = onPage(guard({ entries: ENTRIES }, "group"));
  assert.deepEqual(g.profileKeys(), []);
  assert.match((await g.decide(`${B}type`, fill("e5", "email"))).reason!, /No saved details are available/);
  assert.ok(!browseSystem("Alex", "off", g.profileKeys()).includes("profile:"));
});

test("browse(): only the owner's chat run gets the profile; a group and a wake-up do not; the prompt names keys and no value", async () => {
  const READY = { ok: true as const, cli: "x", exe: "y" };
  const seen: Record<string, string[]> = {};
  const ctx = (name: string, c: { mode: "owner" | "group"; key?: string }) => ({ ...c, run: async (_p: string, g: BrowseGuard) => ((seen[name] = g.profileKeys().map((k) => k.key)), { text: "", structured: { status: "done", answer: "ok", sources: [] } }) });
  await browse(ctx("chat", { mode: "owner", key: OWNER_KEY }), "look up opening hours", { status: READY, profile: { entries: ENTRIES } });
  await browse(ctx("wake", { mode: "owner" }), "look up opening hours", { status: READY, profile: { entries: ENTRIES } });
  await browse(ctx("group", { mode: "group", key: "g1" }), "look up opening hours", { status: READY, profile: { entries: ENTRIES } });
  assert.ok(seen.chat!.includes("passport"));
  assert.deepEqual(seen.wake, []);
  assert.deepEqual(seen.group, []);
  const prompt = browseSystem("Alex", "off", guard().profileKeys());
  assert.match(prompt, /\{\{profile:KEY\}\}/);
  assert.match(prompt, /passport \(id\)/);
  assert.ok(![PASSPORT, EMAIL, NAME].some((v) => prompt.includes(v)));
});

// ---- the final approval ----

const judgeAuto = async (): Promise<Verdict> => ({ decision: "auto", reason: "test" });

test("submit: before any profile fill the judge decides; after one the owner is ALWAYS asked, with host, button, labels, keys, masked sensitive values and the page's total", async () => {
  const g = onPage(guard());
  const before = await g.decide(`${B}click`, { target: "e12" });
  assert.equal(before.kind, "ask");
  assert.equal(before.judge, true);
  assert.ok(!before.description!.includes("Profile fields"));
  for (const [ref, key, label, value] of [["e4", "full_name", "Full name", NAME], ["e6", "passport", "Passport number", PASSPORT]] as const) {
    const d = await g.decide(`${B}type`, fill(ref, key));
    g.shape(`${B}type`, d.input!, echo(SBB, ref, label, value));
  }
  const d = await g.decide(`${B}click`, { target: "e12" });
  assert.equal(d.kind, "ask");
  assert.equal(d.judge, false, "never the judge's call");
  const t = d.description!;
  assert.match(t, /Site: www\.sbb\.ch/);
  assert.match(t, /Button: “Buy ticket”/);
  assert.match(t, /• Full name ← full_name: Annabelle Fakename/, "a non-sensitive value may be shown");
  assert.match(t, /• Passport number ← passport: ••••FAKE \(last 4\)/);
  assert.match(t, /Total \(read from the page by code, not checked by the shop\): CHF 45\.00/);
  assert.ok(!t.includes(PASSPORT) && !t.includes("ZZ99"), "a sensitive value never in full");
  assert.match(t, /always confirm/);
  // no amount on the page: it says so
  const none = onPage(guard(), SBB, page(SBB, "", ""));
  const d0 = await none.decide(`${B}type`, fill("e5", "email"));
  none.shape(`${B}type`, d0.input!, echo(SBB, "e5", "E-mail", EMAIL).replace("- text: Total CHF 45.00", ""));
  assert.match((await none.decide(`${B}click`, { target: "e12" })).description!, /Total: none found on the page/);
  // the facts a model-written question must carry
  const facts = factsOf({}, t);
  for (const m of ["www.sbb.ch", "full_name", "passport", "••••FAKE", "CHF 45.00"]) assert.ok(facts.must.includes(m), m);
  const good = "On www.sbb.ch: buy the ticket? full_name and passport (••••FAKE) were filled; the page says CHF 45.00. Address https://www.sbb.ch/en/booking";
  assert.equal(validateQuestion(good, facts), undefined);
  assert.match(validateQuestion(good.replace("CHF 45.00", "a price"), facts)!, /missing "CHF 45\.00"/);
});

test("canUseTool: a judged fill runs with the real value but only the placeholder reaches the question and the approval call; the submit asks even when the judge says auto", async () => {
  const g = onPage(guard());
  const asked: string[] = [];
  const calls: unknown[] = [];
  const canUse = makeCanUseTool(async (d, call) => (asked.push(d), calls.push(call.input), { approved: true }), "browse", undefined, "book the train", judgeAuto, g);
  const r = (await canUse(`${B}type`, fill("e5", "email"), opts)) as { behavior: string; updatedInput?: Record<string, unknown> };
  assert.equal(r.behavior, "allow");
  assert.equal(r.updatedInput?.text, EMAIL, "approved by the judge or by the owner, it runs with the real value");
  assert.ok(!JSON.stringify(asked).includes(EMAIL) && !JSON.stringify(calls).includes(EMAIL), "a question, if one was asked, has the key only");
  g.shape(`${B}type`, r.updatedInput!, echo(SBB, "e5", "E-mail", EMAIL));
  asked.length = 0;
  const submit = (await canUse(`${B}click`, { target: "e12" }, opts)) as { behavior: string };
  assert.equal(submit.behavior, "allow", "the owner said yes");
  assert.equal(asked.length, 1, "asked although the judge says auto");
  assert.match(asked[0]!, /E-mail ← email/);
  const done = readAudit((e) => e.tool === "browse_step" && e.decision === "ask-owner" && Array.isArray(e.meta?.profileKeys));
  assert.ok(done.length >= 1);
});

test("nothing leaks: no audit row, log field or tool result of a run with fills holds a value", async () => {
  const g = onPage(guard());
  const results: string[] = [];
  for (const [ref, key, label, value] of [["e4", "full_name", "Full name", NAME], ["e5", "email", "E-mail", EMAIL], ["e6", "passport", "Passport number", PASSPORT]] as const) {
    const d = await g.decide(`${B}type`, fill(ref, key));
    results.push(g.shape(`${B}type`, d.input!, echo(SBB, ref, label, value)) ?? "");
  }
  const f = await g.decide(`${B}fill_form`, { fields: [{ target: "e7", name: "Loyalty number", type: "textbox", value: "{{profile:loyalty_sbb}}" }] });
  assert.equal(f.kind, "defer");
  assert.equal((f.input!.fields as { value: string }[])[0]!.value, "LOYALTY-FAKE-1234");
  results.push(g.shape(`${B}fill_form`, f.input!, `### Ran Playwright code\n.fill('LOYALTY-FAKE-1234')\n${page(SBB).replace('textbox "Loyalty number" [ref=e7]', 'textbox "Loyalty number" [ref=e7]: LOYALTY-FAKE-1234')}`) ?? "");
  results.push(g.shape(`${B}snapshot`, {}, page(SBB).replace('textbox "Full name" [ref=e4]', `textbox "Full name" [ref=e4]: ${NAME}`)) ?? "");
  await g.decide(`${B}click`, { target: "e12" });
  for (const v of [NAME, EMAIL, PASSPORT, "LOYALTY-FAKE-1234"]) {
    for (const r of results) assert.ok(!r.includes(v), `result: ${v}`);
    assert.equal(readAudit(() => true, v).length, 0, `audit: ${v}`);
  }
  const rows = readAudit((e) => e.tool === "browse_step" && e.decision === "fill-profile");
  assert.ok(rows.length >= 4 && rows.some((r) => r.meta?.profileKey === "passport" && r.meta?.valueLength === PASSPORT.length));
});

test("the browse tool manifest is unchanged: a saved detail is a browser_type call, so groups have no new tool", async () => {
  const { flagFor } = await import("../src/toolmanifest.ts");
  assert.equal(flagFor(`${B}type`, "browse"), "auto");
  assert.equal(flagFor(`${B}type`, "chat"), undefined);
  assert.equal(flagFor(`${B}type`, "group"), undefined);
  assert.ok(!(await import("../src/browserules.ts")).ALLOWED_BROWSER_TOOLS.some((t) => /profile/.test(t)));
  void parseSnapshot;
});
