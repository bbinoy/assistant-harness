import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Every tunable in one place, read from the environment (see .env.example) and validated
// when the agent starts. A typo fails loudly instead of silently becoming NaN: an interval
// of NaN would make the heartbeat fire every millisecond.

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number from ${min} to ${max} (got "${raw}")`);
  }
  return n;
}

function oneOf<T extends string>(env: Env, name: string, fallback: T, allowed: readonly T[]): T {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
  return raw as T;
}

export function loadSettings(env: Env) {
  return {
    // Who the agent works for and what it is called. Neutral defaults keep the repo impersonal.
    owner: env.OWNER_NAME || "the owner",
    assistant: env.ASSISTANT_NAME || "Assistant",

    // "sonnet" is an alias the SDK resolves to the current Sonnet, so new releases are
    // picked up automatically. Pin a full model id if you prefer stability.
    model: env.HARNESS_MODEL || "sonnet",

    heartbeatMinutes: num(env, "HEARTBEAT_MINUTES", 15, 1, 240),
    heartbeatLive: oneOf(env, "HEARTBEAT_ACTIONS", "live", ["live", "log"] as const) === "live",
    maxArchivesPerTick: num(env, "HEARTBEAT_MAX_ARCHIVES", 25, 0, 500),
    quietStartHour: num(env, "QUIET_START_HOUR", 22, 0, 23),
    quietEndHour: num(env, "QUIET_END_HOUR", 7, 0, 23),

    briefStartHour: num(env, "BRIEF_START_HOUR", 7, 0, 23),
    briefMaxAttempts: num(env, "BRIEF_MAX_ATTEMPTS", 3, 1, 10),

    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 20, 0, 10_000),

    signalHost: "127.0.0.1", // never anything else: signal-cli's socket is unauthenticated
    signalPort: num(env, "SIGNAL_PORT", 7583, 1024, 65_535),

    launchdLabel: env.LAUNCHD_LABEL || `com.${env.USER ?? "user"}.assistant-harness`,

    // Overridable so tests never touch the real state.
    stateDir: env.HARNESS_STATE_DIR ? resolve(env.HARNESS_STATE_DIR) : fileURLToPath(new URL("../state/", import.meta.url)),
  } as const;
}

export const settings = loadSettings(process.env);
export const OWNER = settings.owner;
export const ASSISTANT = settings.assistant;
