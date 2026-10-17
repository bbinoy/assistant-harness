import { OneTimeCodes } from "./onetime.ts";
import { looksLikeApiKey, TENANT_ID, type KeyStore } from "./secrets.ts";
import { OWNER_ID, tenantById } from "./tenants.ts";

// How a tenant's secrets get in. NEVER through chat: a Signal message is kept in logs, backups and the SDK's transcript, and a secret typed
// into one is already leaked. The person gives her Anthropic API key (and, later, other secrets) on a page only she can open, or the owner
// types it at the terminal for her. This file is the INTERFACE and the parts that need no web page; the page itself is phase 2.
//
//   issue(tenant, kind)  -> a one-time ticket (and the link that carries it, once a page exists). The ticket is single-use and expires; only its
//                           hash is stored. The chat may tell her "your link: ..." (the link holds a ticket, not a secret).
//   accept(ticket, value)-> called by the receiving page (phase 2: a small HTTPS server behind a tunnel, end-to-end encrypted in the browser):
//                           checks the ticket, checks the value's shape, stores it in OpenBao under tenants/<id>/..., uses up the ticket.
//   localIntake          -> the implementation hook that needs no web: the owner types the value at a hidden terminal prompt
//                           (`npm run tenants -- set-key <id>`), straight into the same store.
// Whatever implements Intake must keep to: the value never reaches a log, an audit row, a prompt or a message; it goes to the KeyStore and nowhere else.

export type SecretKind = "anthropic_api_key";
export const SECRET_KINDS: readonly SecretKind[] = ["anthropic_api_key"];

export interface Ticket {
  ticket: string; // shown once to whoever starts the flow
  url?: string; // the one-time link, when a page exists (undefined for the local hook)
  expiresAt: number;
}

export type Accepted = { ok: true } | { ok: false; reason: "unknown-ticket" | "bad-value" | "unknown-tenant" | "store-failed" };

export interface Intake {
  issue(tenant: string, kind: SecretKind, now?: number): Promise<Ticket>;
  accept(ticket: string, value: string, now?: number): Promise<Accepted>;
}

export const TICKET_TTL_MS = 30 * 60_000;

interface Payload {
  tenant: string;
  kind: SecretKind;
}

// The tickets (single-use, expiring, hashed) and the store; a page (phase 2) wraps `link`. This is the whole logic of a one-time-link flow
// except the HTTP: with it a page is a form that calls accept().
export class TicketIntake implements Intake {
  readonly keys: KeyStore;
  readonly tickets: OneTimeCodes<Payload>;
  readonly link?: (ticket: string) => string;
  constructor(o: { keys: KeyStore; file?: string; link?: (ticket: string) => string }) {
    this.keys = o.keys;
    this.tickets = new OneTimeCodes<Payload>(o.file ?? "state/intake.json");
    this.link = o.link;
  }
  async issue(tenant: string, kind: SecretKind, now = Date.now()): Promise<Ticket> {
    if (!TENANT_ID.test(tenant) || tenant === OWNER_ID || !tenantById(tenant)) throw new Error("no such tenant");
    if (!SECRET_KINDS.includes(kind)) throw new Error("not a kind of secret");
    const ticket = this.tickets.mint({ tenant, kind }, TICKET_TTL_MS, now);
    if (!ticket) throw new Error("too many open tickets");
    return { ticket, ...(this.link ? { url: this.link(ticket) } : {}), expiresAt: now + TICKET_TTL_MS };
  }
  async accept(ticket: string, value: string, now = Date.now()): Promise<Accepted> {
    // The value's shape is checked before the ticket is used up, so a mistyped key lets her try again with the same link.
    if (!looksLikeApiKey(value.trim())) return { ok: false, reason: "bad-value" };
    const p = this.tickets.redeem(ticket, now);
    if (!p) return { ok: false, reason: "unknown-ticket" };
    if (!tenantById(p.tenant)) return { ok: false, reason: "unknown-tenant" };
    try {
      await this.keys.put(p.tenant, value.trim());
    } catch {
      return { ok: false, reason: "store-failed" }; // the ticket is used up; the owner issues another
    }
    return { ok: true };
  }
}

// The local-only hook: the value is typed by the owner at a terminal prompt that does not echo (profilecli.ts readHiddenFromTerminal), for a tenant
// that exists, and goes straight to the store. No ticket and no link: the terminal is the proof of who is asking.
export async function localIntake(tenant: string, keys: KeyStore, readHidden: (prompt: string) => Promise<string>): Promise<Accepted> {
  if (!TENANT_ID.test(tenant) || tenant === OWNER_ID || !tenantById(tenant)) return { ok: false, reason: "unknown-tenant" };
  const value = (await readHidden(`Anthropic API key for ${tenant} (hidden): `)).trim();
  if (!looksLikeApiKey(value)) return { ok: false, reason: "bad-value" };
  try {
    await keys.put(tenant, value);
    return { ok: true };
  } catch {
    return { ok: false, reason: "store-failed" };
  }
}
