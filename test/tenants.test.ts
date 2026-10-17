import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tenancy: the registry, invitations, routing of unknown senders, the gates of a tenant's turn, per-tenant cooldown and budget.
// Its own data folder (before anything reads the settings), because the registry is a file.
process.env.HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "tenants-test-"));

const { settings } = await import("../src/settings.ts");
const T = await import("../src/tenants.ts");
const R = await import("../src/tenantroute.ts");
const { createTenantRunner } = await import("../src/tenantrun.ts");
const { coolingDown, cooldownUntil, noteRateLimit, resetCooldown } = await import("../src/cooldown.ts");
const { failure, TenantKeyError, RateLimitError } = await import("../src/errors.ts");
const { recordCost, spentToday, tenantOverBudget } = await import("../src/budget.ts");
const { tenant } = await import("../src/conversationmodel.ts");
const { OneTimeCodes, CODE_PATTERN } = await import("../src/onetime.ts");
const { TicketIntake, localIntake } = await import("../src/intake.ts");
const { looksLikeApiKey } = await import("../src/secrets.ts");

const on = settings as unknown as { tenants: boolean; tenantNoticeMinutes: number };
const ACI_A = "11111111-1111-4111-8111-111111111111";
const ACI_B = "22222222-2222-4222-8222-222222222222";
const ACI_C = "33333333-3333-4333-8333-333333333333";
const KEY_A = "sk-" + "ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "sk-" + "ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB";

beforeEach(() => {
  on.tenants = true;
  R.forgetRouting();
  resetCooldown();
});

let n = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
// A new tenant by the real path: an invite code, redeemed.
function join_(name = "Anna", aci = fresh()): import("../src/tenants.ts").TenantRecord {
  const made = T.mintInvite("test")!;
  const rec = T.redeemInvite(made.code, { aci, name });
  assert.ok(rec);
  return rec;
}

test("config: a tenant.json is checked, never trusted; connectors are only an extension point", () => {
  const ok = T.parseTenantConfig({ language: "German", persona: "short and dry", dailyBudgetUsd: 3, maxTurns: 6, browse: false, timezone: "Europe/Berlin" });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.config.dailyBudgetUsd, 3);
  const bad = T.parseTenantConfig({ dailyBudgetUsd: -1, maxTurns: "many", browse: "yes", timezone: "Mars/Base", color: "red", connectors: ["gmail"] });
  assert.deepEqual(bad.config, {});
  assert.equal(bad.problems.length, 6);
  assert.deepEqual(T.parseTenantConfig(undefined), { config: {}, problems: [] });
  assert.equal(T.parseTenantConfig([]).problems.length, 1);
  assert.deepEqual([...T.connectorTools({ config: { connectors: ["gmail"] } })], []); // nothing is granted by listing it
});

test("invites: single use, expire, hashed at rest, forgiving about case and dashes", () => {
  const made = T.mintInvite("for Anna", 1_000_000)!;
  assert.match(made.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.ok(!readFileSync(join(settings.dataDir, T.INVITES), "utf8").includes(made.code), "only the hash is stored");
  assert.equal(T.redeemInvite(made.code.toLowerCase().replaceAll("-", " "), { aci: "not-an-aci" }, 1_000_001), undefined);
  const first = T.redeemInvite(made.code.toLowerCase().replaceAll("-", ""), { aci: ACI_A, name: "Anna" }, 1_000_001);
  assert.ok(first);
  assert.equal(first.status, "invited");
  assert.equal(T.redeemInvite(made.code, { aci: ACI_B }, 1_000_002), undefined, "used up");
  const late = T.mintInvite(undefined, 5_000_000)!;
  assert.equal(T.redeemInvite(late.code, { aci: ACI_B }, 5_000_000 + settings.inviteTtlHours * 3600_000 + 1), undefined, "expired");
  const live = T.mintInvite(undefined, 5_000_000)!;
  assert.equal(T.redeemInvite(live.code, { aci: ACI_A }, 5_000_001), undefined, "someone who already is a tenant cannot join twice");
  assert.ok(T.redeemInvite(live.code, { aci: ACI_B, name: "Bo" }, 5_000_002), "and the code was not spent by that");
});

test("invites: a code carried in a sentence is found, and the code space is bounded", () => {
  assert.equal(CODE_PATTERN.exec("hi! my code is abcd-2345-wxyz, thanks")?.[0], "abcd-2345-wxyz");
  assert.equal(CODE_PATTERN.exec("just a normal sentence about 2025-10-17"), null);
  const codes = new OneTimeCodes<number>("state/test-codes.json");
  for (let i = 0; i < 200; i++) assert.ok(codes.mint(i, 60_000));
  assert.equal(codes.mint(201, 60_000), undefined, "at most 200 open at once");
});

test("a redeemed invite provisions the tenant: owner-only folders, notes, a tenant.json, a key REFERENCE and no key", () => {
  const rec = join_("Anna");
  const ctx = T.tenantContext(rec);
  for (const d of [ctx.dir, ctx.notesDir, ctx.backupDir]) assert.equal(statSync(d).mode & 0o077, 0, d);
  assert.ok(existsSync(ctx.configFile));
  assert.equal(rec.keyRef, `tenants/${rec.id}/anthropic_api_key`);
  assert.ok(!readFileSync(join(settings.dataDir, T.REGISTRY), "utf8").match(/sk-ant|"key"/));
  assert.equal(T.tenantByAci(rec.acis[0]!.toUpperCase())?.id, rec.id, "the account id is matched without regard to case");
  assert.equal(ctx.target, `to:${rec.acis[0]}`);
  assert.ok(ctx.dir.startsWith(settings.tenantsDir) && !ctx.dir.startsWith(settings.memoryDir) && !ctx.dir.startsWith(settings.logsDir) && !ctx.dir.startsWith(settings.stateDir));
  assert.ok(T.listTenants().every((t) => t.keyRef === `tenants/${t.id}/anthropic_api_key`));
  assert.equal(tenant(rec.id).direct, true);
});

test("a hand-edited registry cannot point a tenant at another's key or folder", () => {
  const rec = join_("Bo");
  const file = join(settings.dataDir, T.REGISTRY);
  const reg = JSON.parse(readFileSync(file, "utf8"));
  for (const t of reg.tenants) if (t.id === rec.id) t.keyRef = "tenants/owner/profile/email";
  reg.tenants.push({ id: "../escape", name: "x", acis: [ACI_C], status: "active", created: "now" }, { id: "owner", name: "x", acis: [ACI_C], status: "active", created: "now" });
  writeFileSync(file, JSON.stringify(reg));
  assert.equal(T.tenantById(rec.id)!.keyRef, `tenants/${rec.id}/anthropic_api_key`);
  assert.equal(T.tenantByAci(ACI_C), undefined, "an invalid id never loads, 'owner' included");
});

test("routing: with TENANTS off nothing is answered, as today", () => {
  on.tenants = false;
  assert.deepEqual(R.routeSender({ aci: ACI_C, text: "hello" }), { kind: "ignore", why: "tenants are off" });
  assert.deepEqual(R.routeSender({ aci: ACI_A, text: "hello" }).kind, "ignore", "not even a known tenant");
});

test("routing: an unknown sender gets the fixed invitation, with no model call, and not twice in a row", () => {
  const delivered: string[] = [];
  const said: { to: string; text: string }[] = [];
  const io = { reply: async (to: string, text: string) => void said.push({ to, text }), deliver: (t: { id: string }) => void delivered.push(t.id) };
  const a = R.admitStranger({ fromUuid: ACI_C, name: "Stranger", text: "hello, can you help me?" }, io, 1_000);
  assert.equal(a.kind, "reply");
  assert.deepEqual(said, [{ to: `to:${ACI_C}`, text: R.invitationReply() }]);
  assert.deepEqual(delivered, []);
  const again = R.admitStranger({ fromUuid: ACI_C, text: "hello?" }, io, 2_000);
  assert.deepEqual(again, { kind: "ignore", why: "already answered" });
  assert.equal(said.length, 1);
  R.admitStranger({ fromUuid: ACI_C, text: "still there?" }, io, 1_000 + on.tenantNoticeMinutes * 60_000 + 1);
  assert.equal(said.length, 2, "the next one only after the notice interval");
  assert.deepEqual(R.admitStranger({ text: "no account id" }, io, 9_000_000), { kind: "ignore", why: "no account id" });
  assert.equal(said.length, 2);
});

test("routing: strangers together get at most a few fixed replies an hour, and wrong codes are limited per person", () => {
  const io = { reply: async () => {}, deliver: () => {} };
  let replies = 0;
  for (let i = 0; i < 40; i++) {
    const aci = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`;
    if (R.admitStranger({ fromUuid: aci, text: "hi" }, io, 10_000 + i).kind === "reply") replies++;
  }
  assert.equal(replies, 20);
  R.forgetRouting();
  const outcomes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = R.admitStranger({ fromUuid: ACI_C, text: "ABCD-2345-WXYZ" }, io, 100_000 + i * 1000);
    outcomes.push(d.kind === "ignore" ? d.why : d.kind);
  }
  assert.deepEqual(outcomes, ["reply", ...Array(4).fill("already answered"), ...Array(3).fill("too many wrong codes")]);
  const real = T.mintInvite("brute force")!;
  assert.deepEqual(R.admitStranger({ fromUuid: ACI_C, text: real.code }, io, 110_000), { kind: "ignore", why: "too many wrong codes" }, "a guesser cannot go on to the real one");
});

test("routing: a valid code welcomes her (fixed, with the AI line); she is a tenant from then on; a suspended tenant gets nothing", () => {
  const made = T.mintInvite("for Carl")!;
  const welcomed: string[] = [];
  const said: string[] = [];
  const io = { reply: async (_to: string, text: string) => void said.push(text), deliver: () => {}, welcomed: (t: { id: string }) => void welcomed.push(t.id) };
  const joined = R.admitStranger({ fromUuid: ACI_C, name: "Carl", text: `my code: ${made.code}` }, io);
  assert.equal(joined.kind, "reply");
  assert.equal(welcomed.length, 1);
  assert.ok(said[0]!.startsWith(R.DISCLOSURE) && /API key/.test(said[0]!) && /Welcome, Carl/.test(said[0]!));
  const delivered: string[] = [];
  const next = R.admitStranger({ fromUuid: ACI_C, text: "hello" }, { ...io, deliver: (t) => void delivered.push(t.id) });
  assert.equal(next.kind, "tenant");
  assert.deepEqual(delivered, welcomed);
  T.setStatus(welcomed[0]!, "suspended");
  assert.deepEqual(R.admitStranger({ fromUuid: ACI_C, text: "hello?" }, io), { kind: "ignore", why: "suspended" });
  assert.equal(R.activeTenant(ACI_C), undefined);
  assert.equal(said.length, 1, "nothing was said to a suspended tenant");
});

test("consent: a one-time record; recording it makes an invited tenant active", () => {
  const rec = join_("Dora");
  const ctx = T.tenantContext(rec);
  assert.equal(T.readConsent(ctx), undefined);
  T.recordConsent(ctx, "  Germany \n");
  assert.equal(T.readConsent(ctx)?.region, "Germany");
  assert.equal(T.readConsent(ctx)?.ageConfirmed, true);
  assert.equal(T.tenantById(rec.id)!.status, "active");
});

// ---- a tenant's turn ----

function runner(over: { key?: string | undefined | Error; ask?: (key: string) => Promise<{ text: string; costUsd: number }>; now?: () => number } = {}) {
  const asked: { id: string; key: string; prompt: string }[] = [];
  const r = createTenantRunner({
    keys: () => ({ get: async () => { if (over.key instanceof Error) throw over.key; return over.key; }, put: async () => {}, forget: async () => true }),
    ask: (async (ctx: { id: string }, key: string, prompt: string) => (asked.push({ id: ctx.id, key, prompt }), (over.ask ?? (async () => ({ text: "hello there", costUsd: 0.01 })))(key))) as never,
    now: over.now,
  });
  return { r, asked };
}

test("turn: no API key means 'setup incomplete' with the AI line, no model call and never the instance's login", async () => {
  const rec = join_("Eve");
  const { r, asked } = runner({ key: undefined });
  const first = await r.run(tenant(rec.id), "hello");
  assert.ok(first.text.startsWith(R.DISCLOSURE) && first.text.includes(R.setupIncompleteReply()));
  assert.deepEqual(asked, []);
  const second = await r.run(tenant(rec.id), "hello?");
  assert.equal(second.text, "[[silent]]", "the notice is not repeated every message");
  assert.deepEqual(asked, []);
});

test("turn: with her key the run gets HER key, and the first reply carries the AI line exactly once", async () => {
  const rec = join_("Finn");
  const { r, asked } = runner({ key: KEY_A });
  const one = await r.run(tenant(rec.id), "hi");
  const two = await r.run(tenant(rec.id), "and again");
  assert.deepEqual(asked.map((a) => a.key), [KEY_A, KEY_A]);
  assert.equal(one.text, `${R.DISCLOSURE}\n\nhello there`);
  assert.equal(two.text, "hello there");
});

test("turn: OpenBao unreachable is 'try later', not a quiet fall back", async () => {
  const rec = join_("Gus");
  const { r, asked } = runner({ key: new Error("sealed") });
  const out = await r.run(tenant(rec.id), "hi");
  assert.match(out.text, /secret store/);
  assert.deepEqual(asked, []);
});

test("turn: a suspended tenant (even mid-flight) gets nothing and costs nothing", async () => {
  const rec = join_("Hal");
  const conv = tenant(rec.id);
  T.setStatus(rec.id, "suspended");
  const { r, asked } = runner({ key: KEY_A });
  assert.equal((await r.run(conv, "hi")).text, "[[silent]]");
  assert.deepEqual(asked, []);
});

test("cooldown: one tenant's limit, 400 or 429 pauses only her", async () => {
  const a = join_("Ann");
  const b = join_("Bea");
  const now = Date.now();
  assert.ok(failure("rate_limit", "error", a.id) instanceof TenantKeyError);
  assert.ok(failure("invalid_request", "error", b.id) instanceof TenantKeyError); // HTTP 400 on her key
  resetCooldown(b.id);
  assert.equal(coolingDown(now + 1000, a.id), true);
  assert.equal(coolingDown(now + 1000, b.id), false);
  assert.equal(coolingDown(now + 1000), false, "the instance's own cooldown (background jobs, the owner) is untouched");
  assert.ok(failure("rate_limit", "error") instanceof RateLimitError, "without a tenant it is the old behaviour");
  assert.equal(coolingDown(now + 1000), true);
  resetCooldown();
  noteRateLimit(now, a.id);
  const { r, asked } = runner({ key: KEY_A });
  const paused = await r.run(tenant(a.id), "hi");
  assert.match(paused.text, /paused/);
  const fine = await r.run(tenant(b.id), "hi");
  assert.match(fine.text, /hello there/);
  assert.deepEqual(asked.map((x) => x.id), [b.id], "only Bea's run was made");
  assert.ok(cooldownUntil(a.id) !== undefined);
  assert.equal(cooldownUntil(b.id), undefined);
  assert.equal(failure("authentication_failed", "e", a.id) instanceof TenantKeyError, true, "her refused key is hers to fix, not the owner's login");
  assert.equal(failure("server_error", "e", a.id) instanceof TenantKeyError, false);
});

test("budget: her day is her own ledger against her own limit; the instance's ledger is not touched either way", async () => {
  const rec = join_("Cy");
  const ctx = T.tenantContext(rec);
  const owner0 = spentToday();
  recordCost(0.5, ctx.costFile);
  assert.equal(spentToday(ctx.costFile), 0.5);
  assert.equal(spentToday(), owner0);
  assert.equal(tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd), false);
  recordCost(ctx.dailyBudgetUsd, ctx.costFile);
  assert.equal(tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd), true);
  const { r, asked } = runner({ key: KEY_A });
  const out = await r.run(tenant(rec.id), "hi");
  assert.match(out.text, /daily limit/);
  assert.deepEqual(asked, []);
  writeFileSync(ctx.configFile, JSON.stringify({ dailyBudgetUsd: 1000 }));
  assert.equal(T.tenantContext(rec).dailyBudgetUsd, 1000, "her tenant.json can raise or lower it");
});

test("delete: her folder, her registry entry and her key go; the others stay", async () => {
  const gone = join_("Dee");
  const stay = join_("Eli");
  const ctx = T.tenantContext(gone);
  writeFileSync(join(ctx.notesDir, "people-x.md"), "x");
  const calls: string[] = [];
  const r = await T.deleteTenant(gone.id, { forgetKey: async (id) => void calls.push(`key:${id}`), drop: (id) => void calls.push(`drop:${id}`) });
  assert.deepEqual(r, { removed: true, keyRemoved: true });
  assert.deepEqual(calls, [`drop:${gone.id}`, `key:${gone.id}`]);
  assert.equal(existsSync(ctx.dir), false);
  assert.equal(T.tenantById(gone.id), undefined);
  assert.ok(T.tenantById(stay.id) && existsSync(T.tenantContext(stay).dir));
  assert.deepEqual(await T.deleteTenant(gone.id), { removed: false, keyRemoved: false });
});

test("intake: tickets are single use and expire; a key's shape is checked before the ticket is spent; the local hook needs a tenant", async () => {
  const rec = join_("Fay");
  const stored = new Map<string, string>();
  const keys = { get: async (t: string) => stored.get(t), put: async (t: string, k: string) => void stored.set(t, k), forget: async (t: string) => stored.delete(t) };
  const intake = new TicketIntake({ keys, file: "state/test-intake.json", link: (t) => `https://example.invalid/k/${t}` });
  const t1 = await intake.issue(rec.id, "anthropic_api_key", 10_000);
  assert.match(t1.url!, /^https:\/\/example\.invalid\/k\/[2-9A-Z-]+$/);
  assert.deepEqual(await intake.accept(t1.ticket, "not a key", 10_001), { ok: false, reason: "bad-value" });
  assert.deepEqual(await intake.accept(t1.ticket, KEY_A, 10_002), { ok: true }, "the same link still works after a mistyped key");
  assert.equal(stored.get(rec.id), KEY_A);
  assert.deepEqual(await intake.accept(t1.ticket, KEY_B, 10_003), { ok: false, reason: "unknown-ticket" });
  const t2 = await intake.issue(rec.id, "anthropic_api_key", 20_000);
  assert.deepEqual(await intake.accept(t2.ticket, KEY_B, 20_000 + 31 * 60_000), { ok: false, reason: "unknown-ticket" });
  await assert.rejects(intake.issue("owner", "anthropic_api_key"), /no such tenant/);
  assert.deepEqual(await localIntake("nobody", keys, async () => KEY_B), { ok: false, reason: "unknown-tenant" });
  assert.deepEqual(await localIntake(rec.id, keys, async () => "  " + KEY_B + "\n"), { ok: true });
  assert.equal(stored.get(rec.id), KEY_B);
  assert.ok(looksLikeApiKey(KEY_A) && !looksLikeApiKey("sk-ant-short") && !looksLikeApiKey("hello"));
});

test("doctor: shows each tenant with status, key, consent, budget and a paused key; says nothing when TENANTS is off", async () => {
  const { tenantCheck } = await import("../src/doctor.ts");
  const lines: string[] = [];
  const line = (ok: boolean | "warn", what: string, detail = "") => void lines.push(`${ok === true ? "ok" : ok === "warn" ? "warn" : "FAIL"} ${what} ${detail}`);
  await tenantCheck(line, { on: false });
  assert.deepEqual(lines, ["ok tenants: off TENANTS=off: one person, as always"]);
  lines.length = 0;
  const rec = join_("Doc");
  const ctx = T.tenantContext(rec);
  T.recordConsent(ctx, "Germany");
  recordCost(0.25, ctx.costFile);
  T.setPaused(ctx, Date.now() + 3600_000);
  await tenantCheck(line, { on: true, keys: () => ({ get: async () => KEY_A, put: async () => {}, forget: async () => true }) });
  const mine = lines.find((l) => l.includes(`tenant ${rec.id}`))!;
  assert.match(mine, /^warn /);
  assert.match(mine, /active; today \$0\.25 of \$2; her key is paused until [\d-]+ \d\d:\d\d/);
  assert.ok(!mine.includes(KEY_A));
  assert.match(lines[0]!, /^ok tenants \d+ \(/);
  T.setPaused(ctx, undefined);
  assert.equal(T.pausedUntil(ctx), undefined);
  lines.length = 0;
  await tenantCheck(line, { on: true, keys: () => ({ get: async () => undefined, put: async () => {}, forget: async () => true }) });
  assert.match(lines.find((l) => l.includes(`tenant ${rec.id}`))!, /no API key yet/);
});
