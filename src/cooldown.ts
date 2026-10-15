import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// One shared cooldown for the plan's usage limit. When any model call is refused with a rate limit (errors.ts `failure`),
// the time is remembered; background jobs (the clock look, wake-up runs, the brief and radar, quiet compaction, mail
// triage, the dream, log summaries, notice writing) then skip their model call instead of failing against the API every
// tick. The owner's chat and group turns never check it: the limit may be back, and they have their own notice.
// The reset time is the SDK's own (rate_limit_event, status rejected) when it gave one, else a backoff of 15 minutes that
// doubles per consecutive refusal up to 2 hours. A successful call clears everything. Per process; a restart forgets it
// (one probing call is the cost).

export const BASE_BACKOFF_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 2 * 3600_000;
const MAX_RESET_AHEAD_MS = 12 * 3600_000; // a reset further away than this is not believed
const RESET_SLACK_MS = 30_000;

let until = 0; // epoch ms; 0: no cooldown
let failures = 0; // consecutive refusals in this episode
let announced = false; // the one log line of this episode
let knownReset: number | undefined; // from the SDK, waiting for the failure that uses it

// Feed every message of a stream here: remembers the reset time of a rejected limit.
export function observeRateLimit(m: { type: string; rate_limit_info?: { status?: string; resetsAt?: number } } | SDKMessage): void {
  const info = m.type === "rate_limit_event" ? (m as { rate_limit_info?: { status?: string; resetsAt?: number } }).rate_limit_info : undefined;
  if (info?.status === "rejected" && typeof info.resetsAt === "number") knownReset = info.resetsAt * 1000;
}

export function noteRateLimit(now: number = Date.now()): void {
  failures++;
  const reset = knownReset !== undefined && knownReset > now && knownReset - now <= MAX_RESET_AHEAD_MS ? knownReset + RESET_SLACK_MS : undefined;
  knownReset = undefined;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
  until = Math.max(until, reset ?? now + backoff);
}

// A call went through: the limit is over.
export function noteSuccess(): void {
  if (until && announced) console.log("cooldown: model calls work again, background jobs resume");
  until = 0;
  failures = 0;
  announced = false;
  knownReset = undefined;
}

export const coolingDown = (now: number = Date.now()): boolean => now < until;

// For background jobs: true means skip the model call. Logs once per episode, not per tick.
export function skipForCooldown(what: string, now: number = Date.now()): boolean {
  if (!coolingDown(now)) return false;
  if (!announced) {
    announced = true;
    console.log(`cooldown: usage limit, background model calls paused until ${new Date(until).toTimeString().slice(0, 5)} (first skipped: ${what})`);
  }
  return true;
}

export function resetCooldown(): void {
  until = 0;
  failures = 0;
  announced = false;
  knownReset = undefined;
}
