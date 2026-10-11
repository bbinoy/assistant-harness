import { createHash } from "node:crypto";
import { readJson, writeJson } from "./state.ts";

// A reply the background handler drafted, shown to the owner on Signal, sent with one 👍.
//
// The draft text is written by a model from an untrusted email, so nothing here trusts the
// model's words: the draft's id is taken from the Mailbird tool RESULT, its recipients and text
// are read back from Mailbird, and what the owner sees is exactly what a 👍 sends. If the draft
// changed since it was shown (an edit, a different recipient), nothing is sent and the owner is
// shown the current text again.

const FILE = "state/proposals.json";
const MAX_AGE_MS = 24 * 3600_000;

export interface Proposal {
  ts: number; // timestamp of the Signal message that shows the draft: a 👍 on it sends
  draftMessageId: number;
  to: string[];
  subject: string;
  bodyHash: string;
  at: string;
}

export interface DraftView {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

export const hashBody = (body: string) => createHash("sha256").update(body.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);

// Pure: the draft's messageId from a Mailbird tool result (JSON text, or an MCP content array).
export function extractMessageId(response: unknown): number | undefined {
  const text = typeof response === "string" ? response : JSON.stringify(response ?? "");
  const m = /messageId\\?"?\s*[:=]\s*\\?"?(\d{1,12})/.exec(text); // also inside a JSON string, where the quotes are escaped
  return m ? Number(m[1]) : undefined;
}

// Pure: Mailbird's get_message result as what we show and check. Recipients are lower-cased.
export function viewDraft(msg: unknown): DraftView | undefined {
  const m = msg as { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown } | null;
  if (!m || typeof m.body !== "string") return undefined;
  const addrs = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String((x as { email?: string; address?: string })?.email ?? (x as { address?: string })?.address ?? x).toLowerCase()).filter(Boolean);
  return { to: addrs(m.to), cc: addrs(m.cc), subject: String(m.subject ?? ""), body: m.body };
}

const MAX_SHOWN = 1200;

// A reply draft is the new text ABOVE the quoted original ("> ..." lines, or "On <date> <name> wrote:").
// The owner only needs to read what is new; the whole draft is still what gets sent and checked.
const QUOTE_START = /^(>|On .{5,120} wrote:\s*$|Am .{5,120} schrieb.*:\s*$|Le .{5,120} a [ée]crit\s*:\s*$)/m;
export function authoredPart(body: string): { text: string; hasQuote: boolean } {
  const i = body.search(QUOTE_START);
  return i < 0 ? { text: body.trim(), hasQuote: false } : { text: body.slice(0, i).trim(), hasQuote: true };
}

// Pure: the Signal text. Shows who it goes to and the whole reply (cut and announced if long).
export function proposalText(d: DraftView): string {
  const { text: body, hasQuote } = authoredPart(d.body);
  const cut = body.length > MAX_SHOWN ? `${body.slice(0, MAX_SHOWN)}… (+${body.length - MAX_SHOWN} more characters not shown)` : body;
  const shown = hasQuote ? `${cut}\n\n(the quoted original follows below it in the email)` : cut;
  const cc = d.cc.length ? `\nCc: ${d.cc.join(", ")}` : "";
  return `✉️ Reply ready\nTo: ${d.to.join(", ")}${cc}\nSubject: ${d.subject}\n\n${shown}\n\n👍 on this message sends it. To change something, reply to this message and say what.`;
}

// Pure: may the draft be sent now? Same recipients, same text as shown.
export function stillAsShown(p: Proposal, d: DraftView | undefined): { ok: true } | { ok: false; why: string } {
  if (!d) return { ok: false, why: "the draft is gone" };
  if (d.cc.length > 0) return { ok: false, why: "it now has Cc recipients" };
  if (d.to.join(",") !== [...p.to].join(",")) return { ok: false, why: "its recipients changed" };
  if (hashBody(d.body) !== p.bodyHash) return { ok: false, why: "its text changed since I showed it" };
  return { ok: true };
}

const load = (now = Date.now()) => readJson<Proposal[]>(FILE, []).filter((p) => now - Date.parse(p.at) < MAX_AGE_MS);

export function addProposal(p: Proposal): void {
  writeJson(FILE, [...load(), p]);
}

// Removes and returns the proposal a Signal message timestamp belongs to.
export function takeProposal(ts: number): Proposal | undefined {
  const all = load();
  const p = all.find((x) => x.ts === ts);
  if (p) writeJson(FILE, all.filter((x) => x !== p));
  return p;
}

export const hasProposal = (ts: number) => load().some((p) => p.ts === ts);
