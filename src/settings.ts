import { join, resolve } from "node:path";
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

function list(env: Env, name: string, fallback: readonly string[], valid: RegExp, hint: string): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return [...fallback];
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = items.find((s) => !valid.test(s));
  if (bad) throw new Error(`${name}: "${bad}" is not ${hint}`);
  return items;
}

export function loadSettings(env: Env) {
  // The data root holds three folders: state/ (bookkeeping), logs/ and memory/ (what the
  // model reads). Overridable so tests never touch the real data.
  const dataDir = env.HARNESS_DATA_DIR ? resolve(env.HARNESS_DATA_DIR) : resolve(fileURLToPath(new URL("../", import.meta.url)));
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

    // The radar: while the owner is awake, a model looks at calendar and mail every few hours and
    // writes to them only when something deserves it (src/radar.ts).
    proactive: oneOf(env, "PROACTIVE", "on", ["on", "off"] as const) === "on",
    radarMinutes: num(env, "RADAR_MINUTES", 180, 30, 720),
    maxProactivePerDay: num(env, "MAX_PROACTIVE_PER_DAY", 8, 0, 50),

    // A small model's second opinion on approvals (src/autojudge.ts). It may skip the question for
    // calendar events that only touch you (broad: any source, chat: only in chat); shadow: it judges
    // and logs, you still decide; off: never.
    autoApprove: oneOf(env, "AUTO_APPROVE", "broad", ["off", "shadow", "chat", "broad"] as const),

    briefStartHour: num(env, "BRIEF_START_HOUR", 7, 0, 23),
    briefMaxAttempts: num(env, "BRIEF_MAX_ATTEMPTS", 3, 1, 10),

    // What the model can see (policy.ts, hiddenTools): every tool it sees is re-sent on every
    // model call, so hide what your skills never use. A skill that needs a hidden tool will
    // fail, so list it here. Connectors: tool-name prefixes. Notion and Mailbird: the tools to keep.
    hiddenConnectors: list(
      env,
      "HIDDEN_CONNECTORS",
      ["mcp__claude_ai_Interactive_Brokers_IBKR", "mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Drive", "mcp__claude_ai_Google_Docs", "mcp__claude_ai_Claude_Docs"],
      /^mcp__[\w-]+$/,
      "a tool-name prefix like mcp__claude_ai_Gmail",
    ),
    mailbirdTools: list(
      env,
      "MAILBIRD_TOOLS",
      [
        "summarize_all_inboxes", "list_accounts", "list_folders", "list_conversations", "search_conversations", "get_message", "get_conversation",
        "list_attachments", "get_attachment_content", "archive_conversation", "select_conversation", "reply_to_conversation",
        "reply_all_to_conversation", "create_draft", "update_draft", "forward_conversation", "send_message_now", "get_send_status", "send_self_briefing",
      ],
      /^[a-z_]+$/,
      "a Mailbird tool name like get_message",
    ),
    notionTools: list(env, "NOTION_TOOLS", ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"], /^notion-[\w-]+$/, "a Notion tool name like notion-fetch"),

    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 20, 0, 10_000),

    signalHost: "127.0.0.1", // never anything else: signal-cli's socket is unauthenticated
    signalPort: num(env, "SIGNAL_PORT", 7583, 1024, 65_535),

    launchdLabel: env.LAUNCHD_LABEL || `com.${env.USER ?? "user"}.number-one`,

    // Chat session hygiene: the SDK only compacts near the context limit, so a long-lived
    // session would re-send an ever-growing history on every turn.
    chatIdleResetHours: num(env, "CHAT_IDLE_RESET_HOURS", 6, 1, 168), // idle this long: start a fresh session
    chatCompactTokens: num(env, "CHAT_COMPACT_TOKENS", 110_000, 10_000, 500_000), // a turn this big: compact afterwards (tools and skills alone are ~50k)

    // The bundled skills (plugin/skills) are loaded straight from the repo: nothing to install.
    pluginDir: resolve(fileURLToPath(new URL("../plugin", import.meta.url))),

    dataDir,
    stateDir: join(dataDir, "state"), // bookkeeping the model never reads
    logsDir: join(dataDir, "logs"), // agent.log, audit.jsonl, daemon and launchd output
    memoryDir: join(dataDir, "memory"), // what the model reads: notes/ (the SDK auto-memory) and last-brief.md
  } as const;
}

export const settings = loadSettings(process.env);
export const OWNER = settings.owner;
export const ASSISTANT = settings.assistant;
