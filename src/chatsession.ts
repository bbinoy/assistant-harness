import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { OWNER_SESSION_FILE, planSession, type ChatSession, type CompactMode } from "./session.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

// Every conversation (the owner's chat, each group) persists across restarts, with the hygiene rules in
// session.ts (fresh after idle, compacted when large). total_cost_usd is cumulative across a resumed
// session, so we keep the running total and report each turn's delta. The owner's session pointer is
// state/session.json; a group's is session.json in its own folder (conversation.ts).

export interface Resume {
  resume?: string; // session to continue (chat only)
  previousCost: number; // total_cost_usd is cumulative across a resumed session
  seenAt?: string;
}

const chatPlanOpts = (mode: CompactMode) => ({ idleResetHours: settings.chatIdleResetHours, compactTokens: settings.chatCompactTokens, compactGrowth: settings.chatCompactGrowthTokens, quietMinutes: settings.compactQuietMinutes, mode });

// A conversation continues its saved session unless session.ts says to start fresh.
export function chatResume(announce: boolean, file: string = OWNER_SESSION_FILE, source: Source = "chat"): Resume {
  const saved = readJson<ChatSession>(file, { costUsd: 0 });
  // A fresh session starts its cost total at zero, so the previous total must not be subtracted.
  if (planSession(saved, new Date(), chatPlanOpts("off")) === "fresh") {
    if (announce && saved.sessionId) {
      console.log(`${source}: idle for more than ${settings.chatIdleResetHours}h, starting a fresh session`);
      audit("chat_session", "idle-reset", source);
    }
    return { previousCost: 0 };
  }
  return { resume: saved.sessionId, previousCost: saved.costUsd, seenAt: saved.seenAt };
}

// The options of the /compact run. A group's session was built under the group's isolation (buildOptions: no user settings,
// no connectors, no skills or plugins, auto-memory = its own notes folder), and its compaction must load nothing more than
// that: it is the same session, resumed. The owner's compaction is unchanged.
export function compactOptions(sessionId: string | undefined, source: Source, notesDir?: string): Options {
  const isolated = source === "group";
  return {
    model: settings.model,
    resume: sessionId,
    tools: [],
    settingSources: [],
    ...(isolated ? { strictMcpConfig: true, settings: notesDir ? { autoMemoryEnabled: true, autoMemoryDirectory: notesDir } : { autoMemoryEnabled: false } } : {}),
    maxTurns: 2,
    maxBudgetUsd: 1.0,
    canUseTool: async () => ({ behavior: "deny", message: "No tools during compaction." }),
  };
}

// Is a quiet-time compaction due for this session? A cheap read of the session file, for the heartbeat to ask before it queues anything.
export function compactDue(file: string = OWNER_SESSION_FILE, now: Date = new Date()): boolean {
  return planSession(readJson<ChatSession>(file, { costUsd: 0 }), now, chatPlanOpts("quiet")) === "resume then compact";
}

// Compact a conversation's session (`file`) in place by sending the SDK's own /compact command on the resumed session, if
// session.ts says so for this `mode`: "urgent" right after a reply that left the context far past the limit (the caller waits),
// "quiet" from the heartbeat once the conversation has been still for COMPACT_QUIET_MINUTES. Always called from the conversation's
// serial queue, so a message that arrives meanwhile waits behind it and nothing else touches the file. Never throws.
export async function compactChatIfNeeded(file: string = OWNER_SESSION_FILE, source: Source = "chat", notesDir?: string, mode: "quiet" | "urgent" = "urgent"): Promise<void> {
  try {
    const saved = readJson<ChatSession>(file, { costUsd: 0 });
    if (planSession(saved, new Date(), chatPlanOpts(mode)) !== "resume then compact") return;
    console.log(`${source}: context is ${saved.lastContextTokens} tokens, compacting (${mode})`);
    let boundary: { pre_tokens: number; post_tokens?: number } | undefined;
    for await (const message of query({ prompt: "/compact", options: compactOptions(saved.sessionId, source, notesDir) })) {
      if (message.type === "system" && message.subtype === "compact_boundary") boundary = message.compact_metadata;
      if (message.type !== "result") continue;
      recordCost(message.total_cost_usd - saved.costUsd);
      if (!boundary) throw new Error(`/compact produced no compact_boundary (${message.subtype})`);
      const { compactFailedAt: _cleared, ...rest } = saved;
      writeJson(file, { ...rest, sessionId: message.session_id, costUsd: message.total_cost_usd, lastContextTokens: boundary.post_tokens });
      console.log(`${source}: compacted ${boundary.pre_tokens} -> ${boundary.post_tokens ?? "?"} tokens (${mode})`);
      audit("chat_session", "compacted", source);
      return;
    }
    throw new Error("compaction stream ended without a result");
  } catch (e) {
    console.error(`${source}: compaction failed:`, (e as Error).message);
    audit("chat_session", "compact-failed", source);
    writeJson(file, { ...readJson<ChatSession>(file, { costUsd: 0 }), compactFailedAt: new Date().toISOString() });
  }
}
