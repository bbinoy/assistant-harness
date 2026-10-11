import { query, type CanUseTool, type HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Decision } from "./approvals.ts";
import { audit, type Source } from "./audit.ts";
import { OWNER } from "./identity.ts";
import { recordCost } from "./budget.ts";
import { describeCall } from "./format.ts";
import { BRIEF_SYSTEM, HANDLER_SYSTEM, PERSONA } from "./persona.ts";
import { classify, isReadTool } from "./policy.ts";

// "sonnet" is an alias the SDK resolves to the current Sonnet, so new releases
// are picked up automatically. Set HARNESS_MODEL (e.g. a full model id) to pin one.
const MODEL = process.env.HARNESS_MODEL ?? "sonnet";
const STATE_FILE = new URL("../state/session.json", import.meta.url);

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

// The chat conversation (Note to Self). Its session id is persisted so a restart
// continues the same conversation. total_cost_usd is cumulative across a resumed
// session, so we store the running total and report each turn's delta.
async function loadSession(): Promise<{ sessionId?: string; costUsd: number }> {
  try {
    const d = JSON.parse(await readFile(STATE_FILE, "utf8"));
    return { sessionId: d.sessionId, costUsd: d.costUsd ?? 0 };
  } catch {
    return { costUsd: 0 };
  }
}

async function saveSession(sessionId: string, costUsd: number) {
  await mkdir(new URL("../state/", import.meta.url), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ sessionId, costUsd }), { mode: 0o600 });
}

export interface RunOptions {
  source: Source; // audit tag: who is acting
  systemPrompt: string;
  resumeChatSession: boolean; // chat: continue + save the conversation; brief: fresh every run
  maxTurns: number;
  maxBudgetUsd: number; // hard per-run spend cap
  // Fires after a tool call succeeds. Used to capture the brief the agent sends.
  onToolSuccess?: (tool: string, input: unknown) => void;
}

export async function runAgent(prompt: string, approve: Approve, opts: RunOptions): Promise<AgentReply> {
  const { sessionId: resume, costUsd: previousCost } = opts.resumeChatSession
    ? await loadSession()
    : { sessionId: undefined, costUsd: 0 };

  // Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone.
  const canUseTool: CanUseTool = async (tool, input, { signal }) => {
    const verdict = classify(tool);
    if (verdict === "allow") {
      // Reads log tool + decision only. Writes also log the ids they touch (ids, never
      // content), so "what did it archive?" can always be answered from the audit log.
      await audit(tool, "allow", opts.source, isReadTool(tool) ? undefined : idsOf(input));
      return { behavior: "allow", updatedInput: input };
    }
    if (verdict === "deny") {
      await audit(tool, "deny-policy", opts.source);
      return { behavior: "deny", message: `${tool} is blocked by policy and cannot be used.` };
    }
    const d = await approve(describeCall(tool, input), { tool, input }, signal);
    await audit(
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

  const hooks: Partial<Record<"PostToolUse", HookCallbackMatcher[]>> | undefined = opts.onToolSuccess
    ? {
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === "PostToolUse") opts.onToolSuccess!(input.tool_name, input.tool_input);
                return {};
              },
            ],
          },
        ],
      }
    : undefined;

  const stream = query({
    prompt,
    options: {
      model: MODEL,
      systemPrompt: opts.systemPrompt,
      resume,
      // Built-ins: only Skill. No Bash, no file access. Everything else the agent
      // can do is an MCP tool (Mailbird, Notion, Calendar...), gated by canUseTool.
      tools: ["Skill"],
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
  for await (const message of stream) {
    if (message.type === "assistant" && message.error) lastError = message.error;
    if (message.type !== "result") continue;
    if (opts.resumeChatSession) await saveSession(message.session_id, message.total_cost_usd);
    await recordCost(message.total_cost_usd - previousCost); // failures cost money too
    if (message.subtype === "success" && !message.is_error) {
      return { text: message.result, costUsd: message.total_cost_usd - previousCost };
    }
    if (lastError === "authentication_failed") throw new AuthError("authentication_failed");
    throw new Error(`agent turn ended with ${message.subtype}${lastError ? ` (${lastError})` : ""}`);
  }
  throw new Error("agent stream ended without a result");
}

// Interactive chat: resumes the persistent conversation.
export function ask(prompt: string, approve: Approve): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "chat",
    systemPrompt: PERSONA,
    resumeChatSession: true,
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
    systemPrompt: BRIEF_SYSTEM,
    resumeChatSession: false,
    maxTurns: 120,
    maxBudgetUsd: 5.0,
    onToolSuccess,
  });
}

// Background handling of heartbeat-flagged mail: fresh session, Sonnet, bounded budget.
export function runHandlerTurn(prompt: string, approve: Approve): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "heartbeat",
    systemPrompt: HANDLER_SYSTEM,
    resumeChatSession: false,
    maxTurns: 40,
    maxBudgetUsd: 2.0,
  });
}
