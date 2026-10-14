import { clip } from "./format.ts";

// A reply the background handler drafted is shown to the owner on Signal. The owner answers by
// replying to that message ("send", or what to change); the chat agent then finds the draft and
// calls send_message_now, and the APPROVAL for that call shows the draft read back from Mailbird
// at that moment (agent.ts), so what the owner approves is what is sent, whatever the model said.
//
// The draft text is written by a model from an untrusted email, so nothing here trusts the
// model's words: the draft's id is taken from the Mailbird tool RESULT, and recipients and text
// are read back from Mailbird.

export interface DraftView {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

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
const QUOTE_HEADER = /^(On .{5,120} wrote:|Am .{5,120} schrieb.*:|Le .{5,120} a [ée]crit\s*:)\s*$/;
const QUOTE_START = /^(>|On .{5,120} wrote:\s*$|Am .{5,120} schrieb.*:\s*$|Le .{5,120} a [ée]crit\s*:\s*$)/m;
export function authoredPart(body: string): { text: string; hasQuote: boolean } {
  const i = body.search(QUOTE_START);
  if (i < 0) return { text: body.trim(), hasQuote: false };
  // Only real quote lines (and the "wrote:" line that introduces them) may be left out of what is shown. Any other text after
  // the first quote marker is new text: a reply typed below the quote, or something slipped in under a fake "> ..." line.
  const isQuote = (l: string, k: number) => (k === 0 && QUOTE_HEADER.test(l)) || l.trim() === "" || l.trimStart().startsWith(">");
  const below = body.slice(i).split("\n").filter((l, k) => !isQuote(l, k)).map((l) => l.trim());
  return { text: [body.slice(0, i).trim(), ...below].filter(Boolean).join("\n"), hasQuote: true };
}

function cutBody(d: DraftView): string {
  const { text: body, hasQuote } = authoredPart(d.body);
  const cut = body.length > MAX_SHOWN ? `${body.slice(0, MAX_SHOWN)}… (+${body.length - MAX_SHOWN} more characters not shown)` : body;
  return hasQuote ? `${cut}\n\n(the quoted original follows below it in the email)` : cut;
}

// Recipients and subject come from the mail client (the subject from the sender of the mail being answered): one clean line each, so a
// line break cannot fake another header and an invisible or right-to-left character cannot disguise an address.
const header = (d: DraftView) => `To: ${d.to.map((a) => clip(a, 200)).join(", ")}${d.cc.length ? `\nCc: ${d.cc.map((a) => clip(a, 200)).join(", ")}` : ""}\nSubject: ${clip(d.subject, 200)}`;

// Pure: the Signal text. Shows who it goes to and the whole reply (cut and announced if long).
// The draft id is in it so the chat agent can find the draft when the owner replies to this message.
export function proposalText(d: DraftView, id: number): string {
  return `✉️ Reply ready (draft #${id})\n${header(d)}\n\n${cutBody(d)}\n\nReply to this message with “send” to send it, or say what to change.`;
}

// Pure: the approval prompt for sending a draft, from the draft as Mailbird holds it right now.
export function sendApprovalText(d: DraftView): string {
  return `✉️ Send email now\n${header(d)}\n\n${cutBody(d)}`;
}
