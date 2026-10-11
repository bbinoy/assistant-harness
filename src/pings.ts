import { readJson, writeJson } from "./state.ts";

// What the assistant sent on its own (mail alerts, handled mail, meeting prep, clashes). Kept so
// the chat knows what "yes, do that" or "the second one" refers to: a message the assistant
// sends is otherwise not part of the chat's conversation. The radar also reads it, to avoid
// telling the owner the same thing twice.

const FILE = "memory/recent-pings.json";
const KEEP = 8;
const MAX_AGE_MS = 24 * 3600_000;
const MAX_CHARS = 700;

interface Ping {
  at: string;
  text: string;
}

export function recordPing(text: string, now = new Date()): void {
  const kept = readJson<Ping[]>(FILE, []).filter((p) => now.getTime() - Date.parse(p.at) < MAX_AGE_MS);
  writeJson(FILE, [...kept, { at: now.toISOString(), text: text.slice(0, MAX_CHARS) }].slice(-KEEP));
}

// Pure: the list as plain lines for a prompt, oldest first.
export function pingLines(pings: readonly Ping[], now: Date): string[] {
  return pings
    .filter((p) => now.getTime() - Date.parse(p.at) < MAX_AGE_MS)
    .map((p) => `[${new Date(p.at).toTimeString().slice(0, 5)}] ${p.text.replace(/\s*\n\s*/g, " / ")}`);
}

export const recentPings = (now = new Date()) => pingLines(readJson<Ping[]>(FILE, []), now);
