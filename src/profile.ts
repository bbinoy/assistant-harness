import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeDomain } from "./domains.ts";
import { settings } from "./settings.ts";

// The owner's saved details (name, address, passport number, loyalty numbers...) for the browse worker. NOT secrets in the card-and-password
// sense (those are never stored, see browserules.ts), but private: they sit in one file under state/ encrypted with AES-256-GCM, and the
// key lives only in the macOS Keychain (never on disk, never in .env). The values are entered ONLY at a local terminal (profilecli.ts):
// never through the chat, which is logged and goes to the model. Code reads them to type into a page (browseguard.ts); the model sees key
// names, never values. Everything fails closed: no Keychain, a wrong key or a changed file means "no profile", never a guess.

// ---- the Keychain (the `security` tool, called with arguments, never through a shell) ----

export interface Keychain {
  get(): Promise<string | undefined>; // the key as 64 hex characters; undefined: there is none yet. Throws when the Keychain cannot be read
  set(hex: string): Promise<void>;
}
export const KEYCHAIN_SERVICE = "ted-profile-key";
const KEYCHAIN_ACCOUNT = "ted";

const run = (args: string[], stdin?: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve, reject) => {
    const child = execFile("security", args, { timeout: 15_000, encoding: "utf8" }, (err, stdout) => {
      if (!err) return resolve({ code: 0, out: stdout });
      const code = (err as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ code, out: stdout });
      reject(new Error("the macOS Keychain could not be used (is this a Mac with the `security` tool?)"));
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export const macKeychain = (service = KEYCHAIN_SERVICE): Keychain => ({
  async get() {
    const r = await run(["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT, "-w"]);
    if (r.code === 44) return undefined; // errSecItemNotFound
    if (r.code !== 0) throw new Error(`the Keychain refused to give the key (security exit ${r.code})`);
    const hex = r.out.trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("the Keychain item is not a profile key");
    return hex;
  },
  async set(hex) {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("not a key");
    // The key goes in through the tool's own stdin (interactive mode), not as an argument, so it never shows in the process list.
    const r = await run(["-i"], `add-generic-password -s ${service} -a ${KEYCHAIN_ACCOUNT} -w ${hex} -U\n`);
    if (r.code !== 0) throw new Error(`the Keychain refused to store the key (security exit ${r.code})`);
    if ((await this.get()) !== hex) throw new Error("the key was not stored in the Keychain");
  },
});

// ---- the encrypted file ----

export type Kind = "name" | "email" | "phone" | "address" | "nationality" | "dob" | "id" | "other";
export const KINDS: readonly Kind[] = ["name", "email", "phone", "address", "nationality", "dob", "id", "other"];
export interface Entry {
  value: string;
  kind: Kind;
  domains: string[]; // registered domains this value may be typed on; empty: any https page (only allowed for kinds that are not sensitive)
  labels?: string[]; // words a field label may carry for this key (for kind "other", e.g. a loyalty number)
}
export type Entries = Record<string, Entry>;

const AAD = Buffer.from("ted-profile-v1");
// Sensitive: only on a domain the owner named, and only masked in the approval question. Everything but name, email, phone, address, nationality.
export const SENSITIVE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["dob", "id", "other"]);
export const isSensitive = (e: Pick<Entry, "kind">): boolean => SENSITIVE_KINDS.has(e.kind);
export const KEY_NAME = /^[a-z][a-z0-9._-]{0,39}$/;
export const MAX_VALUE = 200;

export function seal(entries: Entries, hexKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify({ entries }), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
}

// Throws on a wrong key, a changed file or anything that is not a sealed profile.
export function unseal(file: string, hexKey: string): Entries {
  const o = JSON.parse(file) as { v?: number; iv?: string; tag?: string; ct?: string };
  if (o.v !== 1 || typeof o.iv !== "string" || typeof o.tag !== "string" || typeof o.ct !== "string") throw new Error("not a profile file");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), Buffer.from(o.iv, "base64"));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]).toString("utf8");
  const parsed = (JSON.parse(plain) as { entries?: Entries }).entries;
  if (!parsed || typeof parsed !== "object") throw new Error("not a profile");
  const out: Entries = {};
  for (const [k, e] of Object.entries(parsed)) {
    if (!KEY_NAME.test(k) || typeof e?.value !== "string" || !KINDS.includes(e.kind)) continue;
    out[k] = { value: e.value, kind: e.kind, domains: Array.isArray(e.domains) ? e.domains.filter((x) => typeof x === "string") : [], ...(Array.isArray(e.labels) ? { labels: e.labels.filter((x) => typeof x === "string").slice(0, 8) } : {}) };
  }
  return out;
}

export const profilePath = (): string => join(settings.stateDir, "profile.enc");

export class ProfileError extends Error {}

// The store: a file and a Keychain. `read` fails closed (ProfileError with the reason); `write` creates the key on the first save.
export class ProfileStore {
  private readonly keychain: Keychain;
  private readonly path: string;
  constructor(keychain: Keychain = macKeychain(), path: string = profilePath()) {
    this.keychain = keychain;
    this.path = path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  async read(): Promise<Entries> {
    if (!this.exists()) return {};
    if (statSync(this.path).mode & 0o077) throw new ProfileError(`${this.path} is readable by others: run chmod 600 on it`);
    let key: string | undefined;
    try {
      key = await this.keychain.get();
    } catch (e) {
      throw new ProfileError((e as Error).message);
    }
    if (!key) throw new ProfileError("the profile file exists but the Keychain has no key for it");
    try {
      return unseal(readFileSync(this.path, "utf8"), key);
    } catch {
      throw new ProfileError("the profile file does not open with the Keychain key (changed, damaged or from another key)");
    }
  }

  async write(entries: Entries): Promise<void> {
    let key: string | undefined;
    try {
      key = await this.keychain.get();
      if (!key) {
        if (this.exists()) throw new ProfileError("the profile file exists but the Keychain has no key for it; not creating a new key over it");
        key = randomBytes(32).toString("hex");
        await this.keychain.set(key);
      }
    } catch (e) {
      throw e instanceof ProfileError ? e : new ProfileError((e as Error).message);
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, seal(entries, key), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

// ---- kinds, masks, which field a key may go into ----

// Pure. The kind a key name suggests (the owner can set it explicitly).
export function kindOfKey(key: string): Kind {
  const k = key.toLowerCase();
  if (/e-?mail/.test(k)) return "email";
  if (/phone|mobile|\btel|handy|natel/.test(k)) return "phone";
  if (/birth|dob|geburt/.test(k)) return "dob";
  if (/nationalit|citizen/.test(k)) return "nationality";
  if (/passport|passnummer|(^|[._-])id([._-]|$)|identity|licen[cs]e|ahv|ssn|national/.test(k)) return "id";
  if (/address|street|city|zip|postal|plz|country|town|adresse/.test(k)) return "address";
  if (/name/.test(k)) return "name";
  return "other";
}

// What a field's accessible name must look like for a key of this kind (English, German, French). "other" kinds are matched on the key's words.
const FIELD: Record<Exclude<Kind, "other">, RegExp> = {
  name: /name|vorname|nachname|surname|prénom|prenom|\bnom\b|given|family|first|last\b|anrede|title|salutation/i,
  email: /e-?mail|\bmail\b/i,
  phone: /phone|mobile|\btel\b|telefon|handy|natel|\bcell\b|portable/i,
  address: /address|adresse|street|stra(ß|ss)e|\bcity\b|\btown\b|\bort\b|stadt|\bzip\b|postal|\bplz\b|post\s*code|country|\bland\b|\bstate\b|province|\brue\b|ville|\bhouse\b/i,
  nationality: /nationalit|citizen|staatsang/i,
  dob: /birth|\bdob\b|geburt|naissance|\bborn\b/i,
  id: /passport|reisepass|passeport|identity|\bid\b|ausweis|identit|document\s*(number|no)|licen[cs]e|\bahv\b/i,
};
const NOT_A_PERSON_NAME = /user\s*name|benutzer|login|company|firma|card\s*holder|account\s*name/i;

// Pure. Does this field's accessible name plausibly ask for this key's value? (A card or login field never gets here: browseguard.ts refuses those first.)
export function fieldFitsKey(label: string, key: string, e: Pick<Entry, "kind" | "labels">): boolean {
  const l = label.trim();
  if (!l) return false;
  if (e.kind === "name" && NOT_A_PERSON_NAME.test(l)) return false;
  if (e.kind !== "other") return FIELD[e.kind].test(l);
  const words = [...(e.labels ?? []), ...key.split(/[._-]/)].map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  return words.some((w) => l.toLowerCase().includes(w));
}

// Pure. A value as the owner's terminal and the approval question show it: a sensitive one only by its last four characters.
export function maskValue(value: string, sensitive: boolean): string {
  if (sensitive) return value.length >= 8 ? `••••${value.slice(-4)} (last 4)` : "••••";
  return value;
}
export const listMask = (e: Entry): string => (isSensitive(e) ? maskValue(e.value, true) : `${e.value.slice(0, 2)}•••`);

export function checkNewValue(value: string): string | undefined {
  if (!value.trim()) return "an empty value";
  if (value.length > MAX_VALUE) return `longer than ${MAX_VALUE} characters`;
  if (/[\r\n]/.test(value)) return "a value with a line break";
  return undefined;
}

export const cleanDomains = (list: string[]): { domains: string[]; bad: string[] } => {
  const domains: string[] = [];
  const bad: string[] = [];
  for (const raw of list) {
    const d = normalizeDomain(raw);
    if (d) domains.includes(d) || domains.push(d);
    else if (raw.trim()) bad.push(raw);
  }
  return { domains, bad };
};

// The run's view: the entries kept in memory for one browse run (the owner's chat only). Undefined when there is no profile or it cannot be read.
export interface Profile {
  entries: Entries;
}
export async function loadProfile(store: ProfileStore = new ProfileStore(), onProblem: (reason: string) => void = () => {}): Promise<Profile | undefined> {
  if (!store.exists()) return undefined;
  try {
    const entries = await store.read();
    return Object.keys(entries).length ? { entries } : undefined;
  } catch (e) {
    onProblem((e as Error).message);
    return undefined;
  }
}
