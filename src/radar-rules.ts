// The radar's decisions as pure functions: is a run due, and which of the messages a run produced
// may actually be sent? A model decides WHAT is worth an interruption; code decides whether it is
// allowed to interrupt: no repeats, a daily cap, a per-run cap, sane sizes.

export interface RadarState {
  lastRunAt?: string;
  day?: string; // local day the counter belongs to
  sent: number; // messages sent on that day
  keys: Record<string, number>; // dedupe key -> epoch ms it was sent
}

export const KINDS = ["prep", "clash", "mail", "other"] as const;
export type Kind = (typeof KINDS)[number];

export interface Message {
  kind: Kind;
  key: string;
  text: string;
}

export const MAX_PER_RUN = 3;
export const MAX_TEXT = 900;
const KEY_TTL_MS = 3 * 24 * 3600_000;

export const emptyState = (): RadarState => ({ sent: 0, keys: {} });

// Due when it never ran, or the last run is at least `everyMinutes` old.
export function isDue(state: RadarState, now: Date, everyMinutes: number): boolean {
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  return !Number.isFinite(last) || now.getTime() - last >= everyMinutes * 60_000;
}

// A new local day starts a fresh counter; old keys expire.
export function rollover(state: RadarState, today: string, now: Date): RadarState {
  const keys = Object.fromEntries(Object.entries(state.keys).filter(([, at]) => now.getTime() - at < KEY_TTL_MS));
  return state.day === today ? { ...state, keys } : { ...state, day: today, sent: 0, keys };
}

// Whatever the model returned (it is constrained JSON, but never trust shape): only well-formed,
// new messages, at most MAX_PER_RUN and what is left of today's cap.
export function acceptMessages(raw: unknown, state: RadarState, dailyCap: number): Message[] {
  const list = (raw as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of list) {
    const { kind, key, text } = (m ?? {}) as Record<string, unknown>;
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) continue;
    if (typeof key !== "string" || key.trim() === "" || key.length > 160) continue;
    if (typeof text !== "string" || text.trim() === "") continue;
    if (state.keys[key] || seen.has(key)) continue; // already told, or twice in one run
    seen.add(key);
    out.push({ kind: kind as Kind, key, text: text.trim().slice(0, MAX_TEXT) });
  }
  return out.slice(0, Math.max(0, Math.min(MAX_PER_RUN, dailyCap - state.sent)));
}
