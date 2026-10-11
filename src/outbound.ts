import { renderMarkdown, splitSections, toSignalStyles } from "./markdown.ts";
import type { SignalClient } from "./signal.ts";

// Older messages carried this prefix. We no longer send it, but still never process it.
const LEGACY_PREFIX = "🤖 ";
const ECHO_WINDOW_MS = 5 * 60_000;
const CHUNK_LIMIT = 1800; // keep each Signal message comfortably short

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
  // Replies to Note to Self sync back to us as new messages. Two guards stop us
  // answering ourselves: remembered timestamps, and the prefix we refuse to process.
  const sentByUs = new Set<number>();
  // Text we are about to send, registered BEFORE sending. The echo can arrive before the
  // send call returns its timestamp, so the timestamp set alone has a race; this does not.
  const emitted = new Map<string, number>();

  function remember(text: string) {
    const now = Date.now();
    for (const [t, expires] of emitted) if (expires < now) emitted.delete(t);
    emitted.set(text, now + ECHO_WINDOW_MS);
  }

  // True if an incoming message is just one of our own replies syncing back to us.
  function isOwnEcho(m: { text: string; timestamp: number }): boolean {
    return sentByUs.has(m.timestamp) || (emitted.get(m.text) ?? 0) > Date.now() || m.text.startsWith(LEGACY_PREFIX);
  }

  // Sends markdown as styled Signal text. `plain` skips markdown parsing; use it for
  // anything that embeds untrusted text (approval prompts quote email content).
  // Returns the timestamp of the last message sent (what a reaction would target).
  async function reply(text: string, opts: { plain?: boolean } = {}): Promise<number> {
    let last = 0;
    for (const part of chunk(text)) {
      if (opts.plain) {
        remember(part);
        last = await signal.sendNoteToSelf(part);
      } else {
        const r = renderMarkdown(part);
        remember(r.text);
        last = await signal.sendNoteToSelf(r.text, toSignalStyles(r.styles));
      }
      sentByUs.add(last);
    }
    return last;
  }

  const replyPlain = (text: string): Promise<number> => reply(text, { plain: true });

  // One message per section, in order, so a long brief reads as a thread of short messages.
  async function sendBrief(markdown: string) {
    for (const section of splitSections(markdown, CHUNK_LIMIT)) {
      await reply(section);
      await new Promise((r) => setTimeout(r, 400)); // keep delivery order stable
    }
  }

  return { reply, replyPlain, sendBrief, isOwnEcho };
}
export type Outbound = ReturnType<typeof createOutbound>;
