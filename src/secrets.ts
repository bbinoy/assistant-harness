import { readFileSync } from "node:fs";
import { macKeychain, type Keychain } from "./keychain.ts";
import { BaoError, OpenBao, type Data } from "./openbao.ts";
import { settings } from "./settings.ts";

// The tenant layer over the OpenBao client. Every secret item of the app lives at <mount>/tenants/<tenant>/<kind>/<name>, and a TenantSecrets
// can reach only its own tenant's folder (and the tenant's token policy says the same in OpenBao: defence in depth). Code uses this, never the
// model. Today there is one tenant, "owner"; a later multi-user setup adds tenants without moving anything.

export const OWNER = "owner";
export const TENANT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
export const ITEM_NAME = /^[a-z][a-z0-9._-]{0,39}$/;

// The kinds of item. A card is the owner's own, dedicated card and nobody else's: a friend's card verification code must never be stored
// (PCI DSS forbids keeping it after authorisation, and it is no help to anyone but a thief). Enforced here, whatever the caller asks.
export type ItemKind = "profile" | "card";
export const ITEM_KINDS: readonly ItemKind[] = ["profile", "card"];
export const CARD_TENANTS: ReadonlySet<string> = new Set([OWNER]);

export class SecretsError extends Error {}

export class TenantSecrets {
  readonly bao: OpenBao;
  readonly tenant: string;
  constructor(bao: OpenBao, tenant: string = OWNER) {
    if (!TENANT_ID.test(tenant)) throw new SecretsError("not a tenant id");
    this.bao = bao;
    this.tenant = tenant;
  }

  private folder(kind: ItemKind): string {
    if (!ITEM_KINDS.includes(kind)) throw new SecretsError("not a kind of secret item");
    if (kind === "card" && !CARD_TENANTS.has(this.tenant)) throw new SecretsError("a card is never stored for this tenant (only the owner's own card; a friend's security code is never kept)");
    return `tenants/${this.tenant}/${kind}`;
  }
  private path(kind: ItemKind, name: string): string {
    const folder = this.folder(kind);
    if (!ITEM_NAME.test(name)) throw new SecretsError("not a valid item name");
    return `${folder}/${name}`;
  }

  async get(kind: ItemKind, name: string, o: { cache?: boolean } = {}): Promise<Data | undefined> {
    return this.bao.read(this.path(kind, name), o);
  }
  async put(kind: ItemKind, name: string, data: Data): Promise<void> {
    return this.bao.write(this.path(kind, name), data);
  }
  async remove(kind: ItemKind, name: string): Promise<boolean> {
    return this.bao.delete(this.path(kind, name));
  }
  // The item names of a kind, sorted (folders left out).
  async names(kind: ItemKind, o: { cache?: boolean } = {}): Promise<string[]> {
    return (await this.bao.list(this.folder(kind), o)).filter((n) => !n.endsWith("/")).sort();
  }
}

// ---- the app's own connection ----

// Service names of this Mac's Keychain items, from OPENBAO_KEYCHAIN_PREFIX.
export const keychainNames = (prefix: string = settings.openbao.keychainPrefix) => ({
  token: `${prefix}-token`, // the app's own token (policy: tenants/owner/ only)
  operator: `${prefix}-operator`, // the setup tool's token (policy: root generation, rekey, snapshot; no secrets)
  share: (n: number) => `${prefix}-unseal-${n}`,
});

export function caPemOf(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// The app's OpenBao client: the tenant token comes from the Keychain (kept in memory once read, never written anywhere else).
export function appBao(o: { keychain?: Keychain; cfg?: typeof settings.openbao } = {}): OpenBao {
  const cfg = o.cfg ?? settings.openbao;
  const keychain = o.keychain ?? macKeychain;
  let token: { v: string; at: number } | undefined; // kept in memory for a few minutes, so a token replaced by a new setup is picked up without a restart
  const caPem = caPemOf(cfg.caCert);
  if (!caPem && cfg.addr.startsWith("https:")) throw new BaoError(`the pinned certificate ${cfg.caCert} is missing (npm run openbao -- setup)`);
  return new OpenBao({
    addr: cfg.addr,
    mount: cfg.mount,
    ...(caPem ? { caPem } : {}),
    timeoutMs: cfg.timeoutMs,
    cacheMs: cfg.cacheMs,
    token: async () => {
      if (!token || Date.now() - token.at > 300_000) {
        const v = await keychain.get(keychainNames(cfg.keychainPrefix).token);
        if (!v) throw new BaoError("no token");
        token = { v, at: Date.now() };
      }
      return token.v;
    },
  });
}

let shared: TenantSecrets | undefined;
// The owner's secrets, built on first use. Throws a BaoError (a plain reason) when the connection cannot be set up.
export function ownerSecrets(): TenantSecrets {
  return (shared ??= new TenantSecrets(appBao(), OWNER));
}

// ---- tenants' Anthropic API keys ----

// A tenant's own API key lives at tenants/<id>/anthropic_api_key (data: { value }). Only code reads it, at run time, to hand it to that tenant's
// runs through the environment (agentrun.ts); the model never sees it and the registry holds a reference only. The key is entered by the
// person herself through a one-time link or at the owner's terminal (intake.ts), NEVER in chat.
// The app's token is limited to tenants/owner/ by default; `npm run openbao -- setup` with TENANTS=on widens it to read these keys (openbaoadmin.ts policyHcl).
export const KEY_ITEM = "anthropic_api_key";
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{16,300}$/;
export const looksLikeApiKey = (v: unknown): v is string => typeof v === "string" && KEY_SHAPE.test(v);

export interface KeyStore {
  get(tenant: string): Promise<string | undefined>;
  put(tenant: string, key: string): Promise<void>;
  forget(tenant: string): Promise<boolean>;
}

export class TenantKeys implements KeyStore {
  readonly bao: OpenBao;
  constructor(bao: OpenBao) {
    this.bao = bao;
  }
  private path(tenant: string): string {
    if (!TENANT_ID.test(tenant) || tenant === OWNER) throw new SecretsError("not a tenant id"); // the owner uses the instance's own login, never a stored key
    return `tenants/${tenant}/${KEY_ITEM}`;
  }
  async get(tenant: string): Promise<string | undefined> {
    const v = (await this.bao.read(this.path(tenant)))?.value;
    return looksLikeApiKey(v) ? v : undefined; // a missing or malformed item is "no key", and nothing else is guessed
  }
  async put(tenant: string, key: string): Promise<void> {
    if (!looksLikeApiKey(key)) throw new SecretsError("that does not look like an Anthropic API key");
    return this.bao.write(this.path(tenant), { value: key });
  }
  async forget(tenant: string): Promise<boolean> {
    return this.bao.delete(this.path(tenant));
  }
}

let sharedKeys: TenantKeys | undefined;
export function tenantKeys(): TenantKeys {
  return (sharedKeys ??= new TenantKeys(appBao()));
}
