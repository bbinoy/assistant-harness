import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeUrl, type TtsProviderConfig } from "@ted-personal-assistant/signal/tts";

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

// The speech engine (TTS_PROVIDER): Kokoro here, or an optional remote one. Remote settings are checked at start-up:
// a missing key or a plain-http address to another machine stops the agent instead of leaking text or failing later.
function ttsProvider(env: Env, kokoro: { dir: string; voice: string; speed: number }): TtsProviderConfig {
  const provider = oneOf(env, "TTS_PROVIDER", "kokoro", ["kokoro", "elevenlabs", "http"] as const);
  const fallback = oneOf(env, "TTS_FALLBACK", "none", ["none", "kokoro"] as const);
  const timeoutMs = num(env, "TTS_TIMEOUT_SECONDS", 60, 5, 300) * 1000;
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is required with TTS_PROVIDER=${provider}`);
    return v;
  };
  if (provider === "elevenlabs") {
    return { provider, fallback, kokoro, elevenlabs: { apiKey: need("ELEVENLABS_API_KEY"), voiceId: need("ELEVENLABS_VOICE_ID"), modelId: env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2", timeoutMs } };
  }
  if (provider === "http") {
    const url = need("TTS_HTTP_URL");
    if (!isSafeUrl(url)) throw new Error("TTS_HTTP_URL must be an https:// address (http:// only for localhost)");
    return { provider, fallback, kokoro, http: { url, token: env.TTS_HTTP_TOKEN?.trim() || undefined, voice: env.TTS_HTTP_VOICE?.trim() || undefined, referenceId: env.TTS_HTTP_REFERENCE_ID?.trim() || undefined, timeoutMs } };
  }
  return { provider, fallback, kokoro };
}

export function loadSettings(env: Env) {
  const kokoro = {
    dir: env.TTS_DIR || `${env.HOME ?? ""}/.cache/ted-personal-assistant/kokoro`,
    voice: env.TTS_VOICE || "am_onyx",
    speed: num(env, "TTS_SPEED", 0.95, 0.5, 2),
  };
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

    // How long an "Approve?" waits before it counts as declined: one asked in a chat turn, and one asked by an unattended run.
    approvalTimeoutMinutes: num(env, "APPROVAL_TIMEOUT_MINUTES", 15, 1, 1440),
    backgroundApprovalTimeoutMinutes: num(env, "BACKGROUND_APPROVAL_TIMEOUT_MINUTES", 120, 1, 2880),

    // A small model's second opinion on approvals (src/autojudge.ts). It may skip the question for
    // calendar events that only touch you (broad: any source, chat: only in chat); shadow: it judges
    // and logs, you still decide; off: never.
    autoApprove: oneOf(env, "AUTO_APPROVE", "broad", ["off", "shadow", "chat", "broad"] as const),

    briefStartHour: num(env, "BRIEF_START_HOUR", 7, 0, 23), // legacy scheduler: when the brief starts. Gate scheduler: only what the gate's default rules say ("from this hour")
    briefMaxAttempts: num(env, "BRIEF_MAX_ATTEMPTS", 3, 1, 10),
    // Who decides WHEN the brief and the radar run. "gate": the owner's gate (src/gate.ts, wake.ts) chooses, by its default rules
    // and the notes; code keeps the HOW and a deterministic backstop for the brief. "legacy": the old fixed schedulers (src/brief.ts
    // shouldRun, src/radar-rules.ts isDue). One env change switches back.
    scheduler: oneOf(env, "SCHEDULER", "gate", ["gate", "legacy"] as const),
    briefBackstopHour: num(env, "BRIEF_BACKSTOP_HOUR", 9, 0, 24), // gate scheduler: no brief logged today by this hour (local): run it anyway. 24: never

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

    // The log of messages the assistant sent (messages.ts) is bounded by size; older messages become one summary.
    messageLogMb: num(env, "MESSAGE_LOG_MB", 1, 0.01, 100),
    groupLogMb: num(env, "GROUP_LOG_MB", 0.5, 0.01, 100), // per group, the same size-bounding
    summaryWords: num(env, "SUMMARY_WORDS", 60, 10, 400),

    // What background runs may read of the owner's notes (chat reads them as files, on demand), and the
    // nightly "dream" that keeps them up to date (dream.ts).
    memoryMaxNotes: num(env, "MEMORY_MAX_NOTES", 120, 10, 1000),
    memoryRunChars: num(env, "MEMORY_RUN_CHARS", 24_000, 2000, 200_000),
    dream: oneOf(env, "DREAM", "on", ["on", "off"] as const) === "on",

    // Wake-ups (src/gate.ts, src/wake.ts): on every heartbeat tick a small model looks at each conversation whose
    // "next look" has come and decides whether to do something unprompted ("every morning post a fun fact").
    wakeups: oneOf(env, "WAKEUPS", "on", ["on", "off"] as const) === "on",

    dailyBudgetUsd: num(env, "DAILY_BUDGET_USD", 20, 0, 10_000),

    signalHost: "127.0.0.1", // never anything else: signal-cli's socket is unauthenticated
    signalPort: num(env, "SIGNAL_PORT", 7583, 1024, 65_535),

    // Voice notes are transcribed on this Mac with whisper.cpp (src/transcribe.ts); nothing leaves it.
    whisperModel: env.WHISPER_MODEL || `${env.HOME ?? ""}/.cache/ted-personal-assistant/ggml-small.bin`,
    // Spoken replies to voice messages (src/voicereply.ts): local text to speech with Kokoro (scripts/setup-tts.sh).
    voiceReplies: oneOf(env, "VOICE_REPLIES", "on", ["on", "off"] as const) === "on",
    ttsDir: kokoro.dir,
    ttsVoice: kokoro.voice,
    ttsSpeed: kokoro.speed,
    // Optional remote speech (docs/REMOTE-TTS.md): sends the spoken words to a third party or to your own server.
    tts: ttsProvider(env, kokoro),
    // Group chats (own-account mode, src/group.ts): it takes part in any group the owner is in, speaking only
    // when it fits (see PARTICIPATION in persona.ts).
    groupParticipation: oneOf(env, "GROUP_PARTICIPATION", "auto", ["auto", "tagged"] as const), // auto: the assistant judges every message; tagged: only when @mentioned or replied to
    // Every conversation, the owner's chat and each group: wait this long after a message for a burst to end, then answer all of
    // it as one turn. SETTLE_SECONDS; the old name GROUP_DEBOUNCE_SECONDS still works when the new one is not set.
    settleSeconds: num(env, "SETTLE_SECONDS", num(env, "GROUP_DEBOUNCE_SECONDS", 2, 0, 60), 0, 60),
    settleMaxSeconds: num(env, "SETTLE_MAX_SECONDS", 10, 1, 120), // the longest a burst waits since its first message, so continuous chatter cannot postpone the answer forever
    // Warm model processes (src/agent.ts, src/gate.ts): a process started ahead of the next message skips the ~3 s start-up. At most
    // three exist: the owner's chat, the group that spoke last, and one small Haiku process for the participation gate. Each costs
    // about 150 to 200 MB resident and no tokens, and is dropped after WARM_IDLE_MINUTES without use. WARM=off: every turn starts cold.
    // GROUP_WARM and GROUP_WARM_IDLE_MINUTES are the deprecated names of these two (they were group-only); they still work when the new ones are unset.
    warm: oneOf(env, "WARM", oneOf(env, "GROUP_WARM", "on", ["on", "off"] as const), ["on", "off"] as const) === "on",
    warmIdleMinutes: num(env, "WARM_IDLE_MINUTES", num(env, "GROUP_WARM_IDLE_MINUTES", 60, 1, 1440), 1, 1440),
    // The participation gate may ask for a pause before answering an untagged message, to seem natural. "typing…" shows meanwhile,
    // so a long pause only makes the answer late: whatever the gate asks for is cut to this many seconds (0: never wait).
    gateMaxDelaySeconds: num(env, "GATE_MAX_DELAY_SECONDS", 4, 0, 120),
    signalAttachmentsDir: `${env.HOME ?? ""}/.local/share/signal-cli/attachments`,

    launchdLabel: env.LAUNCHD_LABEL || `com.${env.USER ?? "user"}.ted-personal-assistant`,

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
