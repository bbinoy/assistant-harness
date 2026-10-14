// The radar's decisions as pure functions: is a run due, and which of the messages a run produced
// may actually be sent? A model decides WHAT is worth an interruption; code decides whether it is
// allowed to interrupt: no repeats, a daily cap, a per-run cap, sane sizes.

export interface RadarState {
  lastRunAt?: string;
  nudgedAt?: string; // last time the assistant changed the calendar
  nextRunAt?: string; // when the next run is due; set from the calendar after each run, or pulled forward by a nudge
  day?: string; // local day the counter belongs to
  sent: number; // messages sent on that day
  keys: Record<string, number>; // dedupe key -> epoch ms it was sent
}

// The radar run's constrained JSON answer (the output schema of the "radar" profile, agent.ts).
export const RADAR_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["eventsSeen", "nextStartMinutes", "messages"],
    properties: {
      eventsSeen: { type: "integer" }, // proof of looking: the number of calendar events the run read
      nextStartMinutes: { type: ["integer", "null"] }, // minutes until the next timed meeting after this window; null if none in 36h
      messages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "key", "text"],
          properties: {
            kind: { type: "string", enum: ["prep", "clash", "mail", "other"] },
            key: { type: "string" },
            text: { type: "string" },
          },
        },
      },
    },
  },
};

const KINDS = ["prep", "clash", "mail", "other"] as const;
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

// Adaptive cadence. After a run the next one is scheduled LEAD_MINUTES before the next meeting
// (so its prep lands in time), but never sooner than MIN_MINUTES and never later than the
// owner's RADAR_MINUTES. Nothing signals an event the owner adds in their calendar app, so the
// longest wait is the blind spot; a calendar change made by the assistant itself pulls the next
// run forward (nudge), at most MIN_GAP_MINUTES after the last one.
const LEAD_MINUTES = 60;
const MIN_MINUTES = 45;
export const MIN_GAP_MINUTES = 30;
export const WINDOW_MINUTES = 90; // "about to start" means starting within this long

// `nextStartMinutes`: minutes until the next timed meeting, as the run reported it (anything else
// means unknown: wait the longest).
export function scheduleNext(now: Date, nextStartMinutes: unknown, maxMinutes: number): string {
  const known = typeof nextStartMinutes === "number" && Number.isFinite(nextStartMinutes) && nextStartMinutes > 0;
  const wait = known ? Math.min(maxMinutes, Math.max(Math.min(MIN_MINUTES, maxMinutes), nextStartMinutes - LEAD_MINUTES)) : maxMinutes;
  return new Date(now.getTime() + wait * 60_000).toISOString();
}

// The assistant changed the calendar: look again soon (but not in a tight loop).
export function nudge(state: RadarState, now: Date): RadarState {
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  const soonest = Math.max(now.getTime(), Number.isFinite(last) ? last + MIN_GAP_MINUTES * 60_000 : 0);
  const current = state.nextRunAt ? Date.parse(state.nextRunAt) : Infinity;
  return { ...state, nextRunAt: new Date(Math.min(current, soonest)).toISOString(), nudgedAt: now.toISOString() };
}

// Due when it never ran, when the scheduled time has come, or (no schedule) the longest wait has passed.
export function isDue(state: RadarState, now: Date, maxMinutes: number): boolean {
  const next = state.nextRunAt ? Date.parse(state.nextRunAt) : NaN;
  if (Number.isFinite(next)) return now.getTime() >= next;
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  return !Number.isFinite(last) || now.getTime() - last >= maxMinutes * 60_000;
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
