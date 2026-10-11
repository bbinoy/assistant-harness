import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { query, startup, type CanUseTool, type HookCallbackMatcher, type Options, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Decision } from "./approvals.ts";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { describeCall } from "./format.ts";
import { isIndex, isNotePath, LAST_BRIEF, memoryFor, missingSetup, NOTES_DIR, parseNote, readNotes } from "./notes.ts";
import { createMemoryServer } from "./memory-tools.ts";
import { briefSystem, chatSystem, handlerSystem } from "./persona.ts";
import { classify, hiddenTools, isReadTool } from "./policy.ts";
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

// Note changes made during the current chat turn. They are announced ONCE, as one short
// message when the turn ends (consume), not one per tool call. Chat is serial, so a
// module-level list is safe.
const memoryChanges: string[] = [];

// Tool names runs have seen, so policy.hiddenTools() can hide the unused ones by name.
// Seeded with Notion's current tools, so even the very first run is trimmed.
const TOOLS_SEEN = "state/tools-seen.json";
const NOTION_SEED = "ai-search check-mcp-next-steps convert-page-to-skill create-attachment create-comment create-database create-file-upload create-folder create-view download-attachment download-skill duplicate-page get-async-task get-comments get-session-status get-teams get-tool-access get-users list-favorite-pages list-private-pages list-recent-pages list-session-events list-shared-pages move-pages query-data-sources query-meeting-notes query-multiple-data-sources query-sessions read-session-event search-agents search-sessions send-message-to-session show-advanced-analysis-next-steps spawn-session stop-session update-data-source update-folder update-view upload-skill wait-session"
  .split(" ")
  .map((t) => `mcp__claude_ai_Notion__notion-${t}`);
const toolsSeen = () => readJson<string[]>(TOOLS_SEEN, NOTION_SEED);
function recordToolsSeen(tools: readonly string[]) {
  const known = toolsSeen();
  const added = tools.filter((t) => t.startsWith("mcp__") && !known.includes(t));
  if (added.length) writeJson(TOOLS_SEEN, [...known, ...added]);
}

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

const BUNDLED_SKILLS = ["daily-brief", "mailbird", "mailbird-troubleshooting", "calendar", "notion-tasks", "meeting-prep", "setup"].map((s) => `number-one:${s}`);

interface Resume {
  resume?: string; // session to continue (chat only)
  previousCost: number; // total_cost_usd is cumulative across a resumed session
}

// Chat continues its saved session unless session.ts says to start fresh.
function chatResume(announce: boolean): Resume {
  const saved = readJson<ChatSession>(SESSION_FILE, { costUsd: 0 });
  // A fresh session starts its cost total at zero, so the previous total must not be subtracted.
  if (planSession(saved, new Date(), chatPlanOpts()) === "fresh") {
    if (announce && saved.sessionId) {
      console.log(`chat: idle for more than ${settings.chatIdleResetHours}h, starting a fresh session`);
      audit("chat_session", "idle-reset", "chat");
    }
    return { previousCost: 0 };
  }
  return { resume: saved.sessionId, previousCost: saved.costUsd };
}

function buildOptions(approve: Approve, opts: RunOptions, resume: string | undefined): Options {
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
      // The note's own description says what it is; fall back to its first line.
      const described = /^description:\s*["']?(.+?)["']?\s*$/m.exec(written.split(/\n---\n/)[0] ?? "")?.[1];
      const gist = (described ?? body.split("\n")[0]!).slice(0, 160);
      memoryChanges.push(`${tool === "Write" ? "➕ saved" : "✏️ updated"} ${file}: ${gist}`);
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

  return {
    model: settings.model,
    // Wait for every connector before the first model call. By default they connect in the
    // background, and a slow one (seen: ~30s) means the first call runs without its tools,
    // then the tool list changes mid-session, which also throws away the prompt cache. With
    // chat's warm process (below) this wait happens before the message arrives.
    env: { ...process.env, MCP_CONNECTION_NONBLOCKING: "false" },
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
    mcpServers: opts.memoryNotify ? { memory: createMemoryServer((line) => memoryChanges.push(line)) } : undefined,
    resume,
    // Built-ins: Skill, and for chat Read / Write / Edit, which policy.ts confines to the
    // notes folder. No Bash. Everything else the agent can do is an MCP tool (Mailbird,
    // Notion, Calendar...), gated by canUseTool.
    tools: opts.memoryNotify ? ["Skill", "Read", "Write", "Edit"] : ["Skill"],
    // "user" loads user-scope MCP servers (Mailbird) and CLAUDE.md; the skills offered are
    // limited to the bundled ones below.
    // Not "project": there is no project here.
    settingSources: ["user"],
    // The bundled skills, loaded from the repo; only these are offered to the model (the owner's
    // other skills would cost context on every call and are none of its business).
    plugins: [{ type: "local", path: settings.pluginDir, skipMcpDiscovery: true }],
    skills: BUNDLED_SKILLS,
    disallowedTools: hiddenTools(toolsSeen()), // out of the model's view entirely, see policy.ts
    canUseTool,
    hooks,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
  };
}

// The stream yields many message types (system, assistant, tool use...).
// The one we want is the single "result" message that ends the turn.
async function consume(stream: AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKMessage>, opts: RunOptions, previousCost: number): Promise<AgentReply> {
  let lastError: string | undefined;
  let lastContext: number | undefined; // the last model call of the main loop shows how big the context is
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") recordToolsSeen(message.tools);
    if (message.type === "assistant") {
      if (message.error) lastError = message.error;
      if (!message.parent_tool_use_id) lastContext = contextTokens(message.message.usage);
    }
    if (message.type !== "result") continue;
    if (opts.memoryNotify && memoryChanges.length) {
      const lines = memoryChanges.splice(0);
      void opts.memoryNotify(`🧠 Memory\n${lines.join("\n")}\nWrong? Tell me to undo it.`).catch(() => {});
    }
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

export async function runAgent(prompt: string, approve: Approve, opts: RunOptions): Promise<AgentReply> {
  const { resume, previousCost } = opts.resumeChatSession ? chatResume(true) : { resume: undefined, previousCost: 0 };
  return consume(query({ prompt, options: buildOptions(approve, opts, resume) }), opts, previousCost);
}

// --- a warm process for the next chat message ---
// Starting Claude Code (process, config, skills, connectors) takes ~3s before the model is
// even asked. After each reply we start the next chat process in the background, so the
// next message only waits for the model. It is used only if nothing it was built from has
// changed (session, prompt, memory index), and only while fresh; otherwise a normal start.
const SPARE_MAX_AGE_MS = 30 * 60_000;
let spare: { key: string; at: number; warm: Promise<WarmQuery> } | undefined;

const memoryIndex = () => {
  try {
    return readFileSync(`${NOTES_DIR}/MEMORY.md`, "utf8");
  } catch {
    return "";
  }
};
const chatKey = (o: RunOptions, r: Resume) => JSON.stringify([r.resume ?? "", o.systemPrompt, memoryIndex()]);

function discardSpare() {
  const s = spare;
  spare = undefined;
  s?.warm.then((w) => w.close()).catch(() => {});
}

export function prepareChat(approve: Approve, notify: (text: string) => Promise<void>): void {
  discardSpare();
  const o = chatOptions(notify);
  const r = chatResume(false);
  const warm = startup({ options: buildOptions(approve, o, r.resume) });
  warm.catch((e) => {
    console.error("chat warm-up failed:", (e as Error).message);
    if (spare?.warm === warm) spare = undefined;
  });
  spare = { key: chatKey(o, r), at: Date.now(), warm };
}

const chatOptions = (notify: (text: string) => Promise<void>): RunOptions => ({
  source: "chat",
  systemPrompt: chatSystem(readText(LAST_BRIEF), new Date(), missingSetup(readNotes())),
  resumeChatSession: true,
  memoryNotify: notify,
  maxTurns: 40,
  maxBudgetUsd: 2.0, // a cold prompt cache alone can cost most of a dollar
});

// Interactive chat: resumes the persistent conversation, on the warm process when it fits.
export async function ask(prompt: string, approve: Approve, notify: (text: string) => Promise<void>): Promise<AgentReply> {
  const o = chatOptions(notify);
  const r = chatResume(true);
  const s = spare;
  spare = undefined; // a warm process serves one query
  if (s && s.key === chatKey(o, r) && Date.now() - s.at < SPARE_MAX_AGE_MS) {
    // Fall back only if the warm process never came up. Once the turn has started, an error
    // is the turn's error: running it again could repeat what it already did.
    const warm = await s.warm.catch((e: Error) => console.error("chat: warm process unavailable, starting normally:", e.message));
    if (warm) return consume(warm.query(prompt), o, r.previousCost);
  } else {
    s?.warm.then((w) => w.close()).catch(() => {});
  }
  return consume(query({ prompt, options: buildOptions(approve, o, r.resume) }), o, r.previousCost);
}

// Unattended daily brief: a fresh session each run, a bigger budget, no banter.
export function runBriefTurn(
  prompt: string,
  approve: Approve,
  onToolSuccess: (tool: string, input: unknown) => void,
): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "brief",
    systemPrompt: briefSystem(memoryFor(["triage", "people", "scheduling", "context", "brief", "style", "setup", "voice"]), missingSetup(readNotes())),
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
    systemPrompt: handlerSystem(memoryFor(["people", "scheduling", "context", "style", "setup", "voice"]), missingSetup(readNotes())),
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
