// The radar's decisions as pure functions: which of the messages a run produced may actually be sent? A model decides WHAT is worth an interruption; code decides whether it is
// allowed to interrupt: no repeats, a daily cap, a per-run cap, sane sizes.

export interface RadarState {
  sent: number; // messages sent today
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

// MIN_GAP_MINUTES: a calendar change by the assistant pulls the next look forward, at most this long after the last run.
export const MIN_GAP_MINUTES = 30;
export const WINDOW_MINUTES = 90; // "about to start" means starting within this long

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
