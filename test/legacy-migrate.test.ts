import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardStore, type CardRecord } from "../src/card.ts";
import type { Keychain } from "../src/keychain.ts";
import { LEGACY_KEYCHAIN_SERVICE, migrate, readLegacy } from "../src/legacyprofile.ts";
import { ProfileStore, type Entries } from "../src/profile.ts";
import { TenantSecrets } from "../src/secrets.ts";
import { startFakeBao } from "./fakebao.ts";

// The one-time move from the old sealed file to OpenBao. The old format is written here (test only) the way the old code wrote it. Fake values only.
const KEY = "ab".repeat(32);
const ENTRIES: Entries = {
  email: { value: "annabelle.fake@example.com", kind: "email", domains: [] },
  passport: { value: "ZZ9999999FAKE", kind: "id", domains: ["sbb.ch"] },
  loyalty_sbb: { value: "LOYALTY-FAKE-1234", kind: "other", domains: ["sbb.ch"], labels: ["loyalty", "sbb"] },
};
const CARD: CardRecord = { pan: "4242424242424242", expMonth: 12, expYear: 2099, cvc: "737", label: "Wise", last4: "4242", currency: "CHF" };

function sealLegacy(payload: { entries: Entries; card?: unknown }, hexKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  c.setAAD(Buffer.from("ted-profile-v1"));
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
}
const memoryKeychain = (key?: string): Keychain & { items: Map<string, string> } => {
  const items = new Map<string, string>(key ? [[LEGACY_KEYCHAIN_SERVICE, key]] : []);
  return { items, get: async (s) => items.get(s), set: async (s, v) => void items.set(s, v), remove: async (s) => items.delete(s) };
};
const legacyFile = (payload: { entries: Entries; card?: unknown }, key = KEY, mode = 0o600) => {
  const f = join(mkdtempSync(join(tmpdir(), "legacy-")), "profile.enc");
  writeFileSync(f, sealLegacy(payload, key), { mode });
  chmodSync(f, mode);
  return f;
};

test("migrate: every item and the card go into OpenBao, are read back and compared, then the file is deleted and the Keychain key removed; the output holds no value", async () => {
  const fake = await startFakeBao();
  const file = legacyFile({ entries: ENTRIES, card: CARD });
  const kc = memoryKeychain(KEY);
  const lines: string[] = [];
  const secrets = fake.secrets();
  assert.equal(await migrate({ secrets, keychain: kc, file, out: (l) => lines.push(l) }), 0);
  assert.deepEqual(await new ProfileStore(secrets).read(), ENTRIES);
  assert.deepEqual(await new CardStore(secrets).load(), CARD);
  assert.deepEqual([...fake.store.keys()].sort(), ["tenants/owner/card/primary", ...Object.keys(ENTRIES).map((k) => `tenants/owner/profile/${k}`)].sort());
  assert.equal(existsSync(file), false, "the old file is gone");
  assert.equal(kc.items.has(LEGACY_KEYCHAIN_SERVICE), false, "the old key is gone");
  const text = lines.join("\n");
  for (const v of [...Object.values(ENTRIES).map((e) => e.value), CARD.pan, CARD.cvc, KEY]) assert.ok(!text.includes(v), "no value in the output");
  assert.match(text, /Moved 3 profile item\(s\) and the card/);
  // running it again finds nothing to do
  const again: string[] = [];
  assert.equal(await migrate({ secrets, keychain: kc, file, out: (l) => again.push(l) }), 0);
  assert.match(again.join(), /nothing to migrate/);
  await fake.close();
});

test("migrate: a wrong key, no key, a loose file or a sealed OpenBao change nothing", async () => {
  const fake = await startFakeBao();
  const secrets = fake.secrets();
  const run = async (file: string, kc: Keychain) => {
    const lines: string[] = [];
    return { code: await migrate({ secrets, keychain: kc, file, out: (l) => lines.push(l) }).catch((e: Error) => (lines.push(e.message), 2)), text: lines.join("\n") };
  };
  let file = legacyFile({ entries: ENTRIES });
  let r = await run(file, memoryKeychain("cd".repeat(32)));
  assert.equal(r.code, 1);
  assert.match(r.text, /does not open/);
  r = await run(file, memoryKeychain());
  assert.equal(r.code, 1);
  assert.match(r.text, /no key/);
  const loose = legacyFile({ entries: ENTRIES }, KEY, 0o644);
  r = await run(loose, memoryKeychain(KEY));
  assert.equal(r.code, 1);
  assert.match(r.text, /readable by others/);
  fake.mode.sealed = true;
  const kc = memoryKeychain(KEY);
  r = await run(file, kc);
  assert.notEqual(r.code, 0);
  assert.ok(existsSync(file) && kc.items.has(LEGACY_KEYCHAIN_SERVICE), "file and key are still there");
  assert.equal(fake.store.size, 0);
  await fake.close();
});

test("migrate: if what OpenBao gives back differs, nothing is deleted", async () => {
  const fake = await startFakeBao();
  const real = fake.secrets();
  // a store that quietly drops one write
  const lossy = new TenantSecrets(real.bao, "owner");
  const put = lossy.put.bind(lossy);
  lossy.put = async (kind, name, data) => (name === "passport" ? undefined : put(kind, name, data));
  const file = legacyFile({ entries: ENTRIES });
  const kc = memoryKeychain(KEY);
  const lines: string[] = [];
  assert.equal(await migrate({ secrets: lossy, keychain: kc, file, out: (l) => lines.push(l) }), 1);
  assert.match(lines.join("\n"), /Verification failed.*NOT deleted/);
  assert.ok(existsSync(file) && kc.items.has(LEGACY_KEYCHAIN_SERVICE));
  await fake.close();
});

test("the old reader: opens what the old code sealed, rejects a changed file, and knows nothing else (no encrypting code is left)", async () => {
  const sealed = sealLegacy({ entries: ENTRIES, card: CARD }, KEY);
  const o = readLegacy(sealed, KEY);
  assert.deepEqual(o.entries, ENTRIES);
  assert.deepEqual(o.card, CARD);
  assert.throws(() => readLegacy(sealed, "cd".repeat(32)));
  const j = JSON.parse(sealed) as { ct: string };
  assert.throws(() => readLegacy(JSON.stringify({ ...j, ct: Buffer.from("x").toString("base64") }), KEY));
  assert.throws(() => readLegacy("not json", KEY));
  const mod = await import("../src/legacyprofile.ts");
  assert.ok(!Object.keys(mod).some((k) => /seal|encrypt/i.test(k)));
  assert.ok(!/createCipheriv/.test(readFileSync(new URL("../src/legacyprofile.ts", import.meta.url), "utf8")));
});
