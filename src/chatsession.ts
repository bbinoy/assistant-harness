import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { OWNER_SESSION_FILE, planSession, type ChatSession } from "./session.ts";
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

const chatPlanOpts = () => ({ idleResetHours: settings.chatIdleResetHours, compactTokens: settings.chatCompactTokens });

// A conversation continues its saved session unless session.ts says to start fresh.
export function chatResume(announce: boolean, file: string = OWNER_SESSION_FILE, source: Source = "chat"): Resume {
  const saved = readJson<ChatSession>(file, { costUsd: 0 });
  // A fresh session starts its cost total at zero, so the previous total must not be subtracted.
  if (planSession(saved, new Date(), chatPlanOpts()) === "fresh") {
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

// After a turn has been answered (any conversation, `file` is its session): if its context grew past
// CHAT_COMPACT_TOKENS, compact the session in place by sending the SDK's own /compact command on the resumed
// session. Called from the conversation's serial queue, so the next message waits. Never throws.
export async function compactChatIfNeeded(file: string = OWNER_SESSION_FILE, source: Source = "chat", notesDir?: string): Promise<void> {
  try {
    const saved = readJson<ChatSession>(file, { costUsd: 0 });
    if (planSession(saved, new Date(), chatPlanOpts()) !== "resume then compact") return;
    console.log(`${source}: context is ${saved.lastContextTokens} tokens, compacting`);
    let boundary: { pre_tokens: number; post_tokens?: number } | undefined;
    for await (const message of query({ prompt: "/compact", options: compactOptions(saved.sessionId, source, notesDir) })) {
      if (message.type === "system" && message.subtype === "compact_boundary") boundary = message.compact_metadata;
      if (message.type !== "result") continue;
      recordCost(message.total_cost_usd - saved.costUsd);
      if (!boundary) throw new Error(`/compact produced no compact_boundary (${message.subtype})`);
      const { compactFailedAt: _cleared, ...rest } = saved;
      writeJson(file, { ...rest, sessionId: message.session_id, costUsd: message.total_cost_usd, lastContextTokens: boundary.post_tokens });
      console.log(`${source}: compacted ${boundary.pre_tokens} -> ${boundary.post_tokens ?? "?"} tokens`);
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
