import { createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cardOf, CardStore, type CardRecord } from "./card.ts";
import type { Keychain } from "./keychain.ts";
import { entryOf, KEY_NAME, ProfileStore, type Entries, type Entry } from "./profile.ts";
import { OWNER, TenantSecrets } from "./secrets.ts";
import { settings } from "./settings.ts";

// THE ONE-TIME MIGRATION from the old sealed file (state/profile.enc, AES-256-GCM, key in the macOS Keychain) to OpenBao. This is the only
// place the old format is still understood, and only to read it: there is no encrypting here and no fallback anywhere. After a successful
// run the file and the Keychain key are gone, and this module and its command (`npm run openbao -- migrate`) can be deleted
// (git history keeps the old store). Nothing here prints a value: counts and key names only.

export const LEGACY_KEYCHAIN_SERVICE = "ted-profile-key";
export const legacyPath = (): string => join(settings.stateDir, "profile.enc");
const AAD = Buffer.from("ted-profile-v1");

// Reads the old file: the profile entries and the card, if there was one. Throws on a wrong key or a changed file.
export function readLegacy(file: string, hexKey: string): { entries: Entries; card?: CardRecord } {
  const o = JSON.parse(file) as { v?: number; iv?: string; tag?: string; ct?: string };
  if (o.v !== 1 || typeof o.iv !== "string" || typeof o.tag !== "string" || typeof o.ct !== "string") throw new Error("not a profile file");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), Buffer.from(o.iv, "base64"));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  const body = JSON.parse(Buffer.concat([d.update(Buffer.from(o.ct, "base64")), d.final()]).toString("utf8")) as { entries?: Record<string, unknown>; card?: unknown };
  if (!body.entries || typeof body.entries !== "object") throw new Error("not a profile");
  const entries: Entries = {};
  for (const [k, raw] of Object.entries(body.entries)) {
    const e = entryOf(k, raw);
    if (e) entries[k] = e;
  }
  const card = body.card === undefined ? undefined : cardOf(body.card);
  return { entries, ...(card ? { card } : {}) };
}

// Overwrites the file with random bytes, flushes, and removes it. (On APFS an overwrite is not guaranteed to reach the old blocks; the real
// erasure is that the key is removed from the Keychain next: the file is useless without it.)
export function shred(path: string): void {
  const size = statSync(path).size;
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, randomBytes(Math.max(size, 1)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  rmSync(path, { force: true });
}

export interface MigrateDeps {
  secrets: TenantSecrets; // the owner's
  keychain: Keychain;
  file?: string;
  out: (line: string) => void;
}

// Returns the exit code. Reads the old file through the old key, writes every item into OpenBao, reads each back and compares, and only then
// shreds the file and removes the Keychain key. Any problem stops before anything is deleted.
export async function migrate(d: MigrateDeps): Promise<number> {
  const file = d.file ?? legacyPath();
  if (d.secrets.tenant !== OWNER) throw new Error("the old file is the owner's");
  if (!existsSync(file)) {
    d.out(`There is no old profile file (${file}): nothing to migrate.`);
    return 0;
  }
  if (statSync(file).mode & 0o077) {
    d.out(`${file} is readable by others: run chmod 600 on it first.`);
    return 1;
  }
  const key = await d.keychain.get(LEGACY_KEYCHAIN_SERVICE);
  if (!key || !/^[0-9a-f]{64}$/.test(key)) {
    d.out("The old file exists but the Keychain has no key for it (item ted-profile-key). Nothing was changed.");
    return 1;
  }
  let old: ReturnType<typeof readLegacy>;
  try {
    old = readLegacy(readFileSync(file, "utf8"), key);
  } catch {
    d.out("The old file does not open with the Keychain key (changed, damaged or from another key). Nothing was changed.");
    return 1;
  }
  const profile = new ProfileStore(d.secrets);
  const cards = new CardStore(d.secrets);
  const keys = Object.keys(old.entries).filter((k) => KEY_NAME.test(k));
  // write
  for (const k of keys) await profile.set(k, old.entries[k] as Entry);
  if (old.card) await cards.save(old.card);
  // verify by reading back, fresh (no cache), and comparing every field
  const back = await profile.read();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const bad = keys.filter((k) => !back[k] || !same(back[k], old.entries[k]));
  if (bad.length || Object.keys(back).length < keys.length) {
    d.out(`Verification failed for ${bad.length} item(s) (${bad.slice(0, 5).join(", ")}). The old file and key were NOT deleted.`);
    return 1;
  }
  if (old.card) {
    const c = await cards.load();
    if (!c || !same(c, old.card)) {
      d.out("Verification failed for the card. The old file and key were NOT deleted.");
      return 1;
    }
  }
  d.out(`Moved ${keys.length} profile item(s)${old.card ? " and the card" : ""} into OpenBao and read them back: all equal.`);
  shred(file);
  rmSync(`${file}.tmp`, { force: true });
  d.out(`Deleted ${file}.`);
  d.out((await d.keychain.remove(LEGACY_KEYCHAIN_SERVICE)) ? "Removed the old key (ted-profile-key) from the Keychain." : "The old key was already gone from the Keychain.");
  d.out("Check: npm run profile -- list    and    npm run card -- list");
  return 0;
}
