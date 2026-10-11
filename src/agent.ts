import { basename } from "node:path";
import { query, type CanUseTool, type HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { Decision } from "./approvals.ts";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { describeCall } from "./format.ts";
import { isIndex, isNotePath, LAST_BRIEF, memoryFor, NOTES_DIR, parseNote } from "./notes.ts";
import { createMemoryServer } from "./memory-tools.ts";
import { briefSystem, chatSystem, handlerSystem } from "./persona.ts";
import { classify, isReadTool } from "./policy.ts";
import { OWNER, settings } from "./settings.ts";
import { planSession, type ChatSession } from "./session.ts";
import { readJson, readText, writeJson } from "./state.ts";

// Thrown when the credential is rejected, so the caller can tell the owner how to fix it
// instead of showing a generic failure.
export class AuthError extends Error {}

// Pulls id-like fields (id, conversationId, messageId...) out of tool input for the audit log.
export function idsOf(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const ids = Object.fromEntries(
    Object.entries(input).filter(([k, v]) => /(^id$|Id$)/.test(k) && (typeof v === "string" || typeof v === "number")),
  );
  return Object.keys(ids).length ? { ids } : undefined;
}

export interface AgentReply {
  text: string;
  costUsd: number;
}

export type Approve = (
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
) => Promise<Decision>;

// The chat conversation (Note to Self) persists across restarts, with the hygiene rules in
// session.ts (fresh after idle, compacted when large). total_cost_usd is cumulative across a
// resumed session, so we keep the running total and report each turn's delta.
const SESSION_FILE = "state/session.json";

export interface RunOptions {
  source: Source; // audit tag: who is acting
  systemPrompt: string;
  resumeChatSession: boolean; // chat: continue + save the conversation; brief: fresh every run
  memoryNotify?: (text: string) => Promise<void>; // chat only: turns on the SDK's auto-memory (notes in memory/notes/) and announces every change
  maxTurns: number;
  maxBudgetUsd: number; // hard per-run spend cap
  // Fires after a tool call succeeds. Used to capture the brief the agent sends.
  onToolSuccess?: (tool: string, input: unknown) => void;
}

// Context size of one model call: everything it was sent.
const contextTokens = (u: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

const chatPlanOpts = () => ({ idleResetHours: settings.chatIdleResetHours, compactTokens: settings.chatCompactTokens });

export async function runAgent(prompt: string, approve: Approve, opts: RunOptions): Promise<AgentReply> {
  const saved: ChatSession = opts.resumeChatSession ? readJson<ChatSession>(SESSION_FILE, { costUsd: 0 }) : { costUsd: 0 };
  // A fresh session starts its cost total at zero, so the previous total must not be subtracted.
  const fresh = opts.resumeChatSession && planSession(saved, new Date(), chatPlanOpts()) === "fresh";
  if (fresh && saved.sessionId) {
    console.log(`chat: idle for more than ${settings.chatIdleResetHours}h, starting a fresh session`);
    audit("chat_session", "idle-reset", "chat");
  }
  const resume = fresh ? undefined : saved.sessionId;
  const previousCost = fresh ? 0 : saved.costUsd;

  // Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone.
  const canUseTool: CanUseTool = async (tool, input, { signal }) => {
    const verdict = classify(tool, input, opts.source);
    if (verdict === "allow") {
      // Reads log tool + decision only. Writes also log the ids they touch (ids, never
      // content), so "what did it archive?" can always be answered from the audit log.
      audit(tool, "allow", opts.source, isReadTool(tool) ? undefined : idsOf(input));
      return { behavior: "allow", updatedInput: input };
    }
    if (verdict === "deny") {
      audit(tool, "deny-policy", opts.source);
      return { behavior: "deny", message: `${tool} is blocked by policy (or its input is) and cannot be used.` };
    }
    audit(tool, "ask-sent", opts.source); // logged before the wait, so a stuck approval is visible
    const d = await approve(describeCall(tool, input), { tool, input }, signal);
    audit(
      tool,
      d.approved ? (d.updatedInput ? "ask-approved-modified" : "ask-approved") : d.feedback ? "ask-feedback" : "ask-declined",
      opts.source,
    );
    if (d.approved) return { behavior: "allow", updatedInput: d.updatedInput ?? input };
    return {
      behavior: "deny",
      message: d.feedback
        ? `${OWNER} did NOT approve this call. Instead they replied: ${JSON.stringify(d.feedback)}. Act on that reply. If it changes the request, propose the adjusted call; do not repeat the original unchanged.`
        : `${OWNER} declined, or did not answer in time. Do not retry.`,
    };
  };

  // After a successful tool call: announce a note change on the phone (chat), and report the
  // call to whoever asked (the brief captures what it sent).
  const afterTool = async (tool: string, input: Record<string, unknown>) => {
    if (opts.memoryNotify && (tool === "Write" || tool === "Edit") && isNotePath(input.file_path) && !isIndex(input.file_path)) {
      const file = basename(input.file_path);
      const written = String((tool === "Write" ? input.content : input.new_string) ?? "");
      const body = parseNote(file, written)?.text ?? written.trim();
      audit("memory_note", tool === "Write" ? "written" : "edited", "chat");
      void opts.memoryNotify(`🧠 Memory updated (${file}): ${body.slice(0, 400)}${body.length > 400 ? "…" : ""}\nWrong? Tell me to change or forget it.`).catch(() => {});
    }
    opts.onToolSuccess?.(tool, input);
  };
  const hooks: Partial<Record<"PostToolUse", HookCallbackMatcher[]>> = {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse") await afterTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
            return {};
          },
        ],
      },
    ],
  };

  const stream = query({
    prompt,
    options: {
      model: settings.model,
      // Rendered fresh on every request (not recorded once per session): the prompt carries
      // today's date and the last brief, and a change must apply to the very next message.
      // Chat uses Claude Code's preset prompt because that is where the SDK's auto-memory
      // instructions live (with a custom prompt the model says "noted" and saves nothing);
      // our persona and rules are appended. The unattended runs keep a custom prompt and
      // get their notes injected as data (notes.ts).
      systemPrompt: opts.memoryNotify
        ? { type: "preset", preset: "claude_code", append: opts.systemPrompt, snapshot: false }
        : { type: "custom", prompt: opts.systemPrompt, snapshot: false },
      settings: opts.memoryNotify ? { autoMemoryEnabled: true, autoMemoryDirectory: NOTES_DIR } : { autoMemoryEnabled: false },
      mcpServers: opts.memoryNotify ? { memory: createMemoryServer(opts.memoryNotify) } : undefined,
      resume,
      // Built-ins: Skill, and for chat Read / Write / Edit, which policy.ts confines to the
      // notes folder. No Bash. Everything else the agent can do is an MCP tool (Mailbird,
      // Notion, Calendar...), gated by canUseTool.
      tools: opts.memoryNotify ? ["Skill", "Read", "Write", "Edit"] : ["Skill"],
      // "user" loads ~/.claude/skills, user-scope MCP servers and CLAUDE.md.
      // Not "project": there is no project here.
      settingSources: ["user"],
      canUseTool,
      hooks,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
    },
  });

  // The stream yields many message types (system, assistant, tool use...).
  // The one we want is the single "result" message that ends the turn.
  let lastError: string | undefined;
  let lastContext: number | undefined; // the last model call of the main loop shows how big the context is
  for await (const message of stream) {
    if (message.type === "assistant") {
      if (message.error) lastError = message.error;
      if (!message.parent_tool_use_id) lastContext = contextTokens(message.message.usage);
    }
    if (message.type !== "result") continue;
    if (opts.resumeChatSession) {
      const next: ChatSession = { sessionId: message.session_id, costUsd: message.total_cost_usd, lastTurnAt: new Date().toISOString(), lastContextTokens: lastContext };
      writeJson(SESSION_FILE, next);
    }
    recordCost(message.total_cost_usd - previousCost); // failures cost money too
    if (message.subtype === "success" && !message.is_error) {
      return { text: message.result, costUsd: message.total_cost_usd - previousCost };
    }
    if (lastError === "authentication_failed") throw new AuthError("authentication_failed");
    throw new Error(`agent turn ended with ${message.subtype}${lastError ? ` (${lastError})` : ""}`);
  }
  throw new Error("agent stream ended without a result");
}

// Interactive chat: resumes the persistent conversation.
export function ask(prompt: string, approve: Approve, notify: (text: string) => Promise<void>): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "chat",
    systemPrompt: chatSystem(readText(LAST_BRIEF)),
    resumeChatSession: true,
    memoryNotify: notify,
    maxTurns: 40,
    maxBudgetUsd: 1.0,
  });
}

// Unattended daily brief: a fresh session each run, a bigger budget, no banter.
export function runBriefTurn(
  prompt: string,
  approve: Approve,
  onToolSuccess: (tool: string, input: unknown) => void,
): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "brief",
    systemPrompt: briefSystem(memoryFor(["triage", "people", "scheduling", "context", "brief", "style"])),
    resumeChatSession: false,
    maxTurns: 120,
    maxBudgetUsd: 5.0,
    onToolSuccess,
  });
}

// Background handling of heartbeat-flagged mail: fresh session, least privilege (see policy.ts).
export function runHandlerTurn(prompt: string, approve: Approve): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "handler",
    systemPrompt: handlerSystem(memoryFor(["people", "scheduling", "context", "style"])),
    resumeChatSession: false,
    maxTurns: 40,
    maxBudgetUsd: 2.0,
  });
}

// After a chat turn has been answered: if its context grew past CHAT_COMPACT_TOKENS, compact the
// session in place by sending the SDK's own /compact command on the resumed session. Called
// from the serial chat queue, so the next message waits. Never throws: chat must not break.
export async function compactChatIfNeeded(): Promise<void> {
  try {
    const saved = readJson<ChatSession>(SESSION_FILE, { costUsd: 0 });
    if (planSession(saved, new Date(), chatPlanOpts()) !== "resume then compact") return;
    console.log(`chat: context is ${saved.lastContextTokens} tokens, compacting`);
    let boundary: { pre_tokens: number; post_tokens?: number } | undefined;
    for await (const message of query({
      prompt: "/compact",
      options: {
        model: settings.model,
        resume: saved.sessionId,
        tools: [],
        settingSources: [],
        maxTurns: 2,
        maxBudgetUsd: 1.0,
        canUseTool: async () => ({ behavior: "deny", message: "No tools during compaction." }),
      },
    })) {
      if (message.type === "system" && message.subtype === "compact_boundary") boundary = message.compact_metadata;
      if (message.type !== "result") continue;
      recordCost(message.total_cost_usd - saved.costUsd);
      if (!boundary) throw new Error(`/compact produced no compact_boundary (${message.subtype})`);
      const { compactFailedAt: _cleared, ...rest } = saved;
      writeJson(SESSION_FILE, { ...rest, sessionId: message.session_id, costUsd: message.total_cost_usd, lastContextTokens: boundary.post_tokens });
      console.log(`chat: compacted ${boundary.pre_tokens} -> ${boundary.post_tokens ?? "?"} tokens`);
      audit("chat_session", "compacted", "chat");
      return;
    }
    throw new Error("compaction stream ended without a result");
  } catch (e) {
    console.error("chat: compaction failed:", (e as Error).message);
    audit("chat_session", "compact-failed", "chat");
    writeJson(SESSION_FILE, { ...readJson<ChatSession>(SESSION_FILE, { costUsd: 0 }), compactFailedAt: new Date().toISOString() });
  }
}
