import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "./contain.ts";
import { OneTimeCodes } from "./onetime.ts";
import { FILE as OWNER_LOG, type Summarize } from "./messages.ts";
import { NOTES_DIR } from "./notes.ts";
import { clean, LIMITS, oneLine } from "./sanitize.ts";
import { TENANT_ID } from "./secrets.ts";
import { OWNER_SESSION_FILE } from "./session.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { toPerson } from "@ted-personal-assistant/signal";

// Tenants: the people other than the owner who use this instance. The owner is the tenant "owner" (the folders and files the
// instance has always had, unchanged); a friend is a tenant with a folder of her own:
//   tenants/<id>/tenant.json    her typed overrides (TenantConfig)
//   tenants/<id>/notes/         her notes (the SDK's auto-memory); the only place her file tools reach
//   tenants/<id>/backup/        snapshots of her notes
//   tenants/<id>/messages.jsonl everything said in her chat, size-bounded (no summary model: that would run on the owner's login)
//   tenants/<id>/session.json   her resumed SDK session
//   tenants/<id>/cost.json      what she spent today on her own key
//   tenants/<id>/consent.json   the one-time age/region confirmation
//   tenants/<id>/meta.json      small bookkeeping (disclosure shown, notice times)
// The folder is outside logs/, state/ and memory/, which are what the owner's chat may read (policy.ts): the owner does not read a friend's
// notes or history through the assistant. The host's admin can, of course: the files are on the owner's Mac (docs/SAFETY.md).
// The registry state/tenants.json holds ids, sender account ids (ACI), status and a REFERENCE to the API key in OpenBao, never a key.
// Everything is files, read and written synchronously (state.ts); SQLite is for later.

export const OWNER_ID = "owner";
export const REGISTRY = "state/tenants.json";
export const INVITES = "state/invites.json";

export type TenantStatus = "invited" | "active" | "suspended";
export const STATUSES: readonly TenantStatus[] = ["invited", "active", "suspended"];

export interface TenantRecord {
  id: string;
  name: string; // what she is called (from her Signal profile, or what the owner said); one line
  acis: string[]; // her Signal account id(s): the identity (a number can change hands; the ACI does not)
  status: TenantStatus;
  created: string; // ISO time
  keyRef: string; // where her Anthropic API key is in OpenBao (a path, never the key)
}

// Her Signal account id, a UUID.
export const ACI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const keyRefOf = (id: string): string => `tenants/${id}/anthropic_api_key`;

// ---- typed overrides (tenant.json) ----

export interface TenantConfig {
  language?: string; // the language she writes in, as a hint ("German")
  persona?: string; // how she would like the assistant to talk, in her words (data for the prompt, never rules)
  dailyBudgetUsd?: number; // her own daily ceiling on her own key
  maxTurns?: number; // per run
  maxBudgetUsdPerRun?: number; // per run
  browse?: boolean; // false switches the browse tool off for her (it can never be switched on beyond BROWSE)
  voice?: boolean; // false switches the voice tool off for her
  timezone?: string; // an IANA name, for her clock line
  connectors?: string[]; // EXTENSION POINT, off: her own connectors (mail, calendar...) are phase 2; anything listed here is ignored and reported
}

const KNOWN: readonly string[] = ["language", "persona", "dailyBudgetUsd", "maxTurns", "maxBudgetUsdPerRun", "browse", "voice", "timezone", "connectors"];

// Pure. Whatever is in the file, the result is a valid config and `problems` says what was left out. Never throws.
export function parseTenantConfig(raw: unknown): { config: TenantConfig; problems: string[] } {
  const problems: string[] = [];
  const config: TenantConfig = {};
  if (raw === undefined) return { config, problems };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config, problems: ["tenant.json is not an object"] };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KNOWN.includes(k)) problems.push(`unknown setting ${oneLine("setting", k, 40)}`);
  const text = (k: "language" | "timezone" | "persona", max: number, line: boolean) => {
    if (r[k] === undefined) return;
    if (typeof r[k] !== "string") return void problems.push(`${k} must be text`);
    const v = line ? oneLine(k, r[k] as string, max) : clean(k, r[k] as string, { max });
    if (v) config[k] = v;
  };
  text("language", LIMITS.name, true);
  text("timezone", LIMITS.name, true);
  text("persona", LIMITS.brief, false);
  if (config.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: config.timezone });
    } catch {
      problems.push("timezone is not a time zone name");
      delete config.timezone;
    }
  }
  const num = (k: "dailyBudgetUsd" | "maxTurns" | "maxBudgetUsdPerRun", min: number, max: number) => {
    if (r[k] === undefined) return;
    if (typeof r[k] !== "number" || !Number.isFinite(r[k]) || (r[k] as number) < min || (r[k] as number) > max) return void problems.push(`${k} must be a number from ${min} to ${max}`);
    config[k] = r[k] as number;
  };
  num("dailyBudgetUsd", 0, 1000);
  num("maxTurns", 1, 40);
  num("maxBudgetUsdPerRun", 0.01, 20);
  for (const k of ["browse", "voice"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") problems.push(`${k} must be true or false`);
    else config[k] = r[k] as boolean;
  }
  if (r.connectors !== undefined) {
    if (!Array.isArray(r.connectors) || !r.connectors.every((x) => typeof x === "string")) problems.push("connectors must be a list of names");
    else if (r.connectors.length) problems.push("connectors are not supported yet: ignored"); // the extension point (connectorTools below)
  }
  return { config, problems };
}

// ---- what a run for a tenant is ----

export interface TenantContext {
  id: string;
  name: string;
  senders: string[]; // her sender ids (ACI)
  status: TenantStatus;
  target: string; // the conversation target to send to her (a Signal person, packages/signal toPerson)
  dir: string;
  notesDir: string;
  backupDir: string;
  sessionFile: string;
  logFile: string;
  costFile: string;
  configFile: string;
  consentFile: string;
  metaFile: string;
  keyRef: string;
  config: TenantConfig;
  dailyBudgetUsd: number;
  maxTurns: number;
  maxBudgetUsdPerRun: number;
  language?: string;
  persona?: string;
}

const dirOf = (id: string): string => {
  if (!TENANT_ID.test(id) || id === OWNER_ID) throw new Error("not a tenant id");
  return join(settings.tenantsDir, id);
};

export function tenantContext(rec: TenantRecord): TenantContext {
  const dir = dirOf(rec.id);
  const configFile = join(dir, "tenant.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    raw = undefined; // none yet, or damaged: the defaults
  }
  const { config } = parseTenantConfig(raw);
  return {
    id: rec.id,
    name: rec.name,
    senders: [...rec.acis],
    status: rec.status,
    target: toPerson(rec.acis[0] ?? ""),
    dir,
    notesDir: join(dir, "notes"),
    backupDir: join(dir, "backup"),
    sessionFile: join(dir, "session.json"),
    logFile: join(dir, "messages.jsonl"),
    costFile: join(dir, "cost.json"),
    configFile,
    consentFile: join(dir, "consent.json"),
    metaFile: join(dir, "meta.json"),
    keyRef: rec.keyRef,
    config,
    dailyBudgetUsd: config.dailyBudgetUsd ?? settings.tenantDailyBudgetUsd,
    maxTurns: config.maxTurns ?? 12,
    maxBudgetUsdPerRun: config.maxBudgetUsdPerRun ?? 0.5,
    language: config.language,
    persona: config.persona,
  };
}

// The owner as a tenant: the same fields, pointing at the places the instance has always used. Nothing is moved.
export function ownerContext(): Pick<TenantContext, "id" | "name" | "notesDir" | "sessionFile" | "logFile" | "costFile" | "dailyBudgetUsd"> {
  return { id: OWNER_ID, name: settings.owner, notesDir: NOTES_DIR, sessionFile: OWNER_SESSION_FILE, logFile: OWNER_LOG, costFile: "state/cost.json", dailyBudgetUsd: settings.dailyBudgetUsd };
}

// ---- tools a tenant's run may have ----

export const TENANT_CONSENT_TOOL = "mcp__tenant__record_consent";
// Never a tenant's in this phase, whatever her tenant.json says: the owner's connectors and tools, payment and the saved profile. Listed so
// a test can check that nothing here is reachable, and so that adding a tool to the allowed set below cannot slip one in unnoticed.
export const NEVER_FOR_TENANTS: readonly RegExp[] = [/^mcp__mailbird__/, /^mcp__claude_ai_/, /^mcp__tenants__/, /^mcp__browser__/, /^Skill$/, /^WebFetch$/, /^Bash/, /card|payment|profile/i];

// Her connectors: the EXTENSION POINT (phase 2). Off by default; nothing is returned today, whatever tenant.json lists.
export const connectorTools = (_ctx: Pick<TenantContext, "config">): readonly string[] => [];

// The tools her run has: her notes (file tools inside notes/ only), web search, the memory tools, send, voice and browse (the browse
// worker has no profile and no card in this mode, browseguard.ts), and the consent tool. What each may do is still policy.ts.
export function toolsFor(ctx: Pick<TenantContext, "config">): ReadonlySet<string> {
  const t = new Set<string>(["Read", "Write", "Edit", "WebSearch", "mcp__memory__forget_note", "mcp__memory__search_logs", "mcp__send__send", TENANT_CONSENT_TOOL]);
  if (settings.browse && ctx.config.browse !== false) t.add("mcp__browse__browse");
  if (ctx.config.voice !== false) t.add("mcp__voice__voice");
  for (const c of connectorTools(ctx)) t.add(c);
  for (const tool of t) if (NEVER_FOR_TENANTS.some((re) => re.test(tool))) t.delete(tool);
  return t;
}

// ---- the registry ----

interface Registry {
  tenants: TenantRecord[];
}

const validRecord = (x: unknown): x is TenantRecord => {
  const r = x as TenantRecord;
  return !!r && typeof r.id === "string" && TENANT_ID.test(r.id) && r.id !== OWNER_ID && typeof r.name === "string" && Array.isArray(r.acis) && r.acis.every((a) => typeof a === "string" && ACI.test(a)) && STATUSES.includes(r.status) && typeof r.created === "string";
};

export function listTenants(): TenantRecord[] {
  return (readJson<Partial<Registry>>(REGISTRY, {}).tenants ?? []).filter(validRecord).map((r) => ({ ...r, keyRef: keyRefOf(r.id) })); // keyRef is derived: a hand-edited registry cannot point a tenant at another's key
}
const save = (tenants: TenantRecord[]) => writeJson(REGISTRY, { tenants });

export const tenantById = (id: string): TenantRecord | undefined => listTenants().find((t) => t.id === id);
export const tenantByAci = (aci: string | undefined): TenantRecord | undefined => (aci && ACI.test(aci) ? listTenants().find((t) => t.acis.some((a) => a.toLowerCase() === aci.toLowerCase())) : undefined);
// The conversation target of a tenant (to send to her), for the outbound path.
export const targetOf = (id: string): string | undefined => {
  const t = tenantById(id);
  return t?.acis[0] ? toPerson(t.acis[0]) : undefined;
};
export const tenantByTarget = (target: string | undefined): TenantRecord | undefined => (target?.startsWith("to:") ? tenantByAci(target.slice(3)) : undefined);

// A new id from her name: lower case, a short random tail so two Annas never collide.
export function newTenantId(name: string, taken: ReadonlySet<string> = new Set(listTenants().map((t) => t.id))): string {
  const base = (name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "") || "friend").slice(0, 20).replace(/-+$/, "") || "friend";
  for (;;) {
    const id = `${base}-${Math.random().toString(16).slice(2, 6)}`;
    if (!taken.has(id) && TENANT_ID.test(id)) return id;
  }
}

// Folders and files of a tenant, owner-only. Idempotent.
export function provision(rec: TenantRecord): TenantContext {
  const ctx = tenantContext(rec);
  mkdirSync(ctx.notesDir, { recursive: true, mode: 0o700 });
  mkdirSync(ctx.backupDir, { recursive: true, mode: 0o700 });
  if (!existsSync(ctx.configFile)) writeFileSync(ctx.configFile, "{}\n", { mode: 0o600 });
  return tenantContext(rec);
}

export interface Invite {
  note?: string; // what the owner called it ("for Anna")
}
export const invites = (): OneTimeCodes<Invite> => new OneTimeCodes<Invite>(INVITES);

// The owner's: a single-use code, valid for INVITE_TTL_HOURS. Undefined: too many are open.
export function mintInvite(note?: string, now = Date.now()): { code: string; expiresAt: number } | undefined {
  const ttl = settings.inviteTtlHours * 3600_000;
  const code = invites().mint({ note: note ? oneLine("invite note", note, LIMITS.name) : undefined }, ttl, now);
  return code ? { code, expiresAt: now + ttl } : undefined;
}

// A new sender with a valid code becomes a tenant, 'invited' until she has confirmed age and region; provisioned at once.
// Undefined: the code is not valid (unknown, used, expired).
export function redeemInvite(code: string, who: { aci: string; name?: string }, now = Date.now()): TenantRecord | undefined {
  if (!ACI.test(who.aci)) return undefined;
  if (tenantByAci(who.aci)) return undefined; // she already is one
  const invite = invites().redeem(code, now);
  if (!invite) return undefined;
  const all = listTenants();
  const name = oneLine("tenant name", (who.name || invite.note || "a friend").replace(/[<>"]/g, " "), LIMITS.name) || "a friend";
  const id = newTenantId(name, new Set(all.map((t) => t.id)));
  const rec: TenantRecord = { id, name, acis: [who.aci], status: "invited", created: new Date(now).toISOString(), keyRef: keyRefOf(id) };
  save([...all, rec]);
  provision(rec);
  console.log(`tenants: ${id} joined with an invitation`);
  return rec;
}

export function setStatus(id: string, status: TenantStatus): TenantRecord | undefined {
  const all = listTenants();
  const at = all.findIndex((t) => t.id === id);
  if (at < 0) return undefined;
  all[at] = { ...all[at]!, status };
  save(all);
  return all[at];
}

// Remove a tenant and her data: the registry entry, her folder (notes, history, session, cost, consent), her API key in OpenBao (`forgetKey`).
// What the host already holds elsewhere (the SDK's own transcript of her sessions under ~/.claude, backups of the Mac) is not reached: docs/SAFETY.md.
export async function deleteTenant(id: string, o: { forgetKey?: (id: string) => Promise<void>; drop?: (id: string) => void } = {}): Promise<{ removed: boolean; keyRemoved: boolean }> {
  const rec = tenantById(id);
  if (!rec) return { removed: false, keyRemoved: false };
  save(listTenants().filter((t) => t.id !== id)); // first: from this moment she is nobody
  o.drop?.(id);
  const dir = dirOf(id);
  if (isInside(dir, settings.tenantsDir)) rmSync(dir, { recursive: true, force: true });
  let keyRemoved = false;
  try {
    await o.forgetKey?.(id);
    keyRemoved = !!o.forgetKey;
  } catch (e) {
    console.error(`tenants: ${id}'s key could not be removed from OpenBao: ${(e as Error).message}`);
  }
  console.log(`tenants: ${id} deleted`);
  return { removed: true, keyRemoved };
}

// ---- consent, disclosure, notice times: small files in her folder ----

export interface Consent {
  at: string;
  ageConfirmed: true; // she said she is 18 or older
  region: string; // where she lives, as she said it
  version: 1;
}
export const readConsent = (ctx: Pick<TenantContext, "consentFile">): Consent | undefined => {
  const c = readJson<Partial<Consent> | undefined>(ctx.consentFile, undefined);
  return c && c.ageConfirmed === true && typeof c.region === "string" ? (c as Consent) : undefined;
};
export function recordConsent(ctx: Pick<TenantContext, "consentFile" | "id">, region: string, now = new Date()): Consent {
  const c: Consent = { at: now.toISOString(), ageConfirmed: true, region: oneLine("region", region, LIMITS.name), version: 1 };
  writeJson(ctx.consentFile, c);
  const rec = tenantById(ctx.id);
  if (rec && rec.status === "invited") setStatus(ctx.id, "active");
  return c;
}

interface Meta {
  disclosedAt?: string;
  noticeAt?: Record<string, string>;
  pausedUntil?: number; // her key's cooldown (cooldown.ts keeps it in memory; this is for `npm run doctor`, a separate process)
}
const meta = (ctx: Pick<TenantContext, "metaFile">): Meta => readJson<Meta>(ctx.metaFile, {});
export const wasDisclosed = (ctx: Pick<TenantContext, "metaFile">): boolean => !!meta(ctx).disclosedAt;
export const markDisclosed = (ctx: Pick<TenantContext, "metaFile">): void => writeJson(ctx.metaFile, { ...meta(ctx), disclosedAt: new Date().toISOString() });
export const pausedUntil = (ctx: Pick<TenantContext, "metaFile">, now = Date.now()): number | undefined => {
  const u = meta(ctx).pausedUntil;
  return typeof u === "number" && u > now ? u : undefined;
};
export function setPaused(ctx: Pick<TenantContext, "metaFile">, until: number | undefined): void {
  const { pausedUntil: _old, ...rest } = meta(ctx);
  if (until !== undefined || _old !== undefined) writeJson(ctx.metaFile, until !== undefined ? { ...rest, pausedUntil: until } : rest);
}
// A fixed notice (setup incomplete, budget, cooldown) at most every TENANT_NOTICE_MINUTES: true when it may be sent now (and is marked).
export function mayNotice(ctx: Pick<TenantContext, "metaFile">, kind: string, now = Date.now()): boolean {
  const m = meta(ctx);
  const last = Date.parse(m.noticeAt?.[kind] ?? "");
  if (Number.isFinite(last) && now - last < settings.tenantNoticeMinutes * 60_000) return false;
  writeJson(ctx.metaFile, { ...m, noticeAt: { ...m.noticeAt, [kind]: new Date(now).toISOString() } });
  return true;
}

// Her history is bounded like every log, but never summarised by a model: that call would run on the owner's login, over her words.
export const plainSummary: Summarize = async (_previous, old) => `${old.length} earlier messages (older history is not kept in full)`;
