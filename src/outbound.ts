import { renderMarkdown, splitSections, toSignalStyles } from "./markdown.ts";
import type { Quote, SignalClient } from "./signal.ts";

const CHUNK_LIMIT = 1800; // keep each Signal message comfortably short
const ECHO_WINDOW_MS = 5 * 60_000;

// Split long text on paragraph, then line, then hard boundaries.
export function chunk(text: string, limit = CHUNK_LIMIT): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function createOutbound(signal: SignalClient) {
  // Everything we send to Note to Self comes back to us as an incoming message, and must not
  // be answered. Each message is registered BEFORE sending, by text (the echo can arrive
  // before the send returns its timestamp), then by timestamp. Entries expire after a while.
  const recent = new Map<string, number>(); // key -> expiry (epoch ms)

  function remember(key: string) {
    const now = Date.now();
    for (const [k, expires] of recent) if (expires < now) recent.delete(k);
    recent.set(key, now + ECHO_WINDOW_MS);
  }

  function isOwnEcho(m: { text: string; timestamp: number }): boolean {
    const now = Date.now();
    return (recent.get(`t:${m.timestamp}`) ?? 0) > now || (recent.get(`x:${m.text}`) ?? 0) > now;
  }

  // Sends markdown as styled Signal text. `plain` skips markdown parsing: use it for anything
  // that embeds untrusted text (approval prompts and alerts quote email content).
  // Returns the timestamp of the last message sent (what a reaction would target).
  // `quote` threads the reply under a message of the owner's (first chunk only).
  async function reply(text: string, opts: { plain?: boolean; quote?: Quote } = {}): Promise<number> {
    let last = 0;
    let quote = opts.quote;
    for (const part of chunk(text)) {
      const r = opts.plain ? { text: part, styles: [] } : renderMarkdown(part);
      remember(`x:${r.text}`);
      last = await signal.sendNoteToSelf(r.text, toSignalStyles(r.styles), quote);
      quote = undefined;
      remember(`t:${last}`);
    }
    return last;
  }

  const replyPlain = (text: string) => reply(text, { plain: true });

  // One message per section, in order, so a long brief reads as a thread of short messages.
  async function sendBrief(markdown: string) {
    for (const section of splitSections(markdown, CHUNK_LIMIT)) {
      await reply(section);
      await new Promise((r) => setTimeout(r, 400)); // keep delivery order stable
    }
  }

  return { reply, replyPlain, sendBrief, isOwnEcho };
}
