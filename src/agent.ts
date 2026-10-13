import { AuthError, failure, RateLimitError } from "./errors.ts";
import { sendApprovalText, type DraftView } from "./proposals.ts";
import { changesCalendar, nudgeRadar } from "./radar-nudge.ts";
import { RADAR_SCHEMA } from "./radar-rules.ts";
import { basename } from "node:path";
import { isJudgeable, judgeAction, mayAutoApprove, type Verdict } from "./autojudge.ts";
import { readFileSync } from "node:fs";
import type { Conversation } from "./conversation.ts";
import { userInput, type Picture } from "./image.ts";
import { query, startup, type CanUseTool, type HookCallbackMatcher, type Options, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Decision } from "./approvals.ts";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { describeCall } from "./format.ts";
import { disconnected, readConnectors, recordConnectors } from "./connectors.ts";
import { isIndex, isNotePath, type Category, LAST_BRIEF, memoryFor, missingSetup, NOTES_DIR, parseNote, readNotes } from "./notes.ts";
import { createMemoryServer } from "./memory-tools.ts";
import { backgroundSystem, briefSystem, chatSystem, groupSystem, handlerSystem, radarSystem } from "./persona.ts";
import { classify, hiddenTools, isReadTool } from "./policy.ts";
import { recentNotices } from "./messages.ts";
import { splitReaction } from "./reaction.ts";
import { OWNER, settings } from "./settings.ts";
import { planSession, type ChatSession } from "./session.ts";
import { readJson, readText, writeJson } from "./state.ts";

// Thrown when the credential is rejected, so the caller can tell the owner how to fix it
// instead of showing a generic failure.
export { AuthError, RateLimitError };

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
  structured?: unknown; // the run's constrained JSON output, when it asked for one
}

export type Approve = (
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal: AbortSignal,
) => Promise<Decision>;

// Every conversation (the owner's chat, each group) persists across restarts, with the hygiene rules in
// session.ts (fresh after idle, compacted when large). total_cost_usd is cumulative across a resumed
// session, so we keep the running total and report each turn's delta. The owner's session pointer is
// state/session.json; a group's is session.json in its own folder (conversation.ts).
const SESSION_FILE = "state/session.json";

// Note changes made during the current chat turn. They are announced ONCE, as one short
// message when the turn ends (consume), not one per tool call. Chat is serial, so a
// module-level list is safe.
const memoryChanges: string[] = [];

// Pure: true when the reply has no words of its own, so a memory change would otherwise go unmentioned.
export const needsMemoryNotice = (reply: string) => splitReaction(reply).text.trim() === "";

// Tool names runs have seen, so policy.hiddenTools() can hide the unused ones by name.
// Seeded with Notion's and Mailbird's current tools, so even the very first run is trimmed.
const TOOLS_SEEN = "state/tools-seen.json";
const NOTION_NAMES = "ai-search check-mcp-next-steps convert-page-to-skill create-attachment create-comment create-database create-file-upload create-folder create-view download-attachment download-skill duplicate-page get-async-task get-comments get-session-status get-teams get-tool-access get-users list-favorite-pages list-private-pages list-recent-pages list-session-events list-shared-pages move-pages query-data-sources query-meeting-notes query-multiple-data-sources query-sessions read-session-event search-agents search-sessions send-message-to-session show-advanced-analysis-next-steps spawn-session stop-session update-data-source update-folder update-view upload-skill wait-session"
  .split(" ")
  .map((t) => `mcp__claude_ai_Notion__notion-${t}`);
const MAILBIRD_NAMES = "archive_conversation copy_conversation create_draft delete_conversation_permanently discard_draft forward_conversation get_attachment_content get_conversation get_help get_message get_send_status get_ui_state list_accounts list_attachments list_conversations list_folders mark_all_as_read move_conversation move_conversation_to_inbox reply_all_to_conversation reply_to_conversation search_conversations select_conversation send_message_now send_self_briefing set_conversation_important set_conversation_read set_conversation_spam set_conversation_starred set_sender_blocked show_notification snooze_conversation summarize_all_inboxes trash_conversation unsubscribe_from_newsletter update_draft"
  .split(" ")
  .map((t) => `mcp__mailbird__${t}`);
const SEED = [...NOTION_NAMES, ...MAILBIRD_NAMES];
const toolsSeen = () => readJson<string[]>(TOOLS_SEEN, SEED);
function recordToolsSeen(tools: readonly string[]) {
  const known = toolsSeen();
  const added = tools.filter((t) => t.startsWith("mcp__") && !known.includes(t));
  if (added.length) writeJson(TOOLS_SEEN, [...known, ...added]);
}

// What the owner just said in chat, for the approval judge. A module-level value because the warm
// chat process is built before the message arrives; chat turns run one at a time.
let chatOwnerMessage: string | undefined;

// Where "done without asking" notices go (set by main).
let autoApprovedNotice: ((text: string) => Promise<void>) | undefined;
export const setAutoApprovedNotice = (fn: (text: string) => Promise<void>) => void (autoApprovedNotice = fn);

export interface RunOptions {
  source: Source; // audit tag: who is acting
  systemPrompt: string;
  sessionFile?: string; // chat and groups: continue + save the conversation here; brief and the rest: fresh every run
  // Turns on the SDK's auto-memory: notes in `dir`, the only place the file tools may write (policy.ts).
  // `notify` announces every change on the phone: the owner's chat only; a group's reply says what was saved.
  memory?: { dir: string; groupId?: string; notify?: (text: string) => Promise<void> };
  seenAt?: string; // groups: stored with the session, see ChatSession.seenAt
  skills?: readonly string[]; // the skills offered (default: all bundled ones, OFFERED_SKILLS)
  maxTurns: number;
  maxBudgetUsd: number; // hard per-run spend cap. Per RUN, not per session: the SDK does not count the cost a resumed session already had (checked), so owner and groups alike need no adjustment here. The previous total is subtracted only when reporting cost (consume)
  outputFormat?: Options["outputFormat"]; // constrained JSON output
  // Fires after a tool call succeeds. Used to capture the brief the agent sends.
  onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void;
  onFirstOutput?: () => void; // the model's first message arrived (timing only)
}

// Context size of one model call: everything it was sent.
const contextTokens = (u: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

const chatPlanOpts = () => ({ idleResetHours: settings.chatIdleResetHours, compactTokens: settings.chatCompactTokens });

const down = () => disconnected(readConnectors());
// The only skills the model can load. The SDK enforces this list (anything else is refused with
// "not in this session's skills allowlist"); Skill calls never reach canUseTool.
const OFFERED_SKILLS = ["daily-brief", "mailbird", "mailbird-troubleshooting", "calendar", "notion-tasks", "meeting-prep", "setup", "radar"].map((s) => `ted-personal-assistant:${s}`);

// ---- run profiles ----
// HOW a run is allowed to work, fixed in code and named: the policy source (policy.ts: which tools are allowed, asked,
// denied), the system prompt, the skills offered, the turn and budget limits and the output schema. A Task (tasks.ts)
// names one; the gate can choose a task but never edit a profile. `notes` are the note categories injected as data.
export type ProfileName = "brief" | "radar" | "background" | "group";
export interface RunProfile {
  readonly source: Source;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly skills: readonly string[];
  readonly outputSchema?: Options["outputFormat"];
  readonly notes: readonly Category[];
}
export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  // Unattended daily brief: a fresh session each run, a bigger budget, no banter.
  brief: { source: "brief", maxTurns: 120, maxBudgetUsd: 5.0, skills: OFFERED_SKILLS, notes: ["triage", "people", "scheduling", "context", "brief", "style", "setup", "voice"] },
  // The proactive radar: a fresh session each time; it answers with constrained JSON.
  radar: { source: "radar", maxTurns: 30, maxBudgetUsd: 1.0, skills: OFFERED_SKILLS, outputSchema: RADAR_SCHEMA, notes: ["people", "scheduling", "context", "style", "brief", "setup", "voice"] },
  // An unprompted free-form run in the owner's chat (a wake-up): the radar's rights (reads; anything else asks on the phone),
  // web search allowed (page fetches ask), no memory tools (policy.ts, source "background").
  background: { source: "background", maxTurns: 20, maxBudgetUsd: 1.0, skills: OFFERED_SKILLS, notes: ["people", "scheduling", "context", "style", "brief", "setup", "voice"] },
  // A group's run: its own resumed session, its own notes folder as memory, nothing of the owner's (policy source "group").
  group: { source: "group", maxTurns: 8, maxBudgetUsd: 0.5, skills: OFFERED_SKILLS, notes: [] },
};

export type OwnerProfile = Exclude<ProfileName, "group">;
function profileSystem(name: OwnerProfile): string {
  const notes = memoryFor(PROFILES[name].notes);
  const missing = missingSetup(readNotes(), down());
  return name === "brief" ? briefSystem(notes, missing, down()) : name === "radar" ? radarSystem(notes, missing, down()) : backgroundSystem(notes, missing, down());
}

// The options of an owner profile's run (a fresh session).
export function profileOptions(name: OwnerProfile, extra: { onToolSuccess?: RunOptions["onToolSuccess"] } = {}): RunOptions {
  const p = PROFILES[name];
  return { source: p.source, systemPrompt: profileSystem(name), skills: p.skills, maxTurns: p.maxTurns, maxBudgetUsd: p.maxBudgetUsd, outputFormat: p.outputSchema, onToolSuccess: extra.onToolSuccess };
}

// One run under a named owner profile: always a fresh session.
export const runProfile = (name: OwnerProfile, prompt: string, approve: Approve, extra: { onToolSuccess?: RunOptions["onToolSuccess"] } = {}): Promise<AgentReply> =>
  runAgent(prompt, approve, profileOptions(name, extra));

interface Resume {
  resume?: string; // session to continue (chat only)
  previousCost: number; // total_cost_usd is cumulative across a resumed session
  seenAt?: string;
}

// A conversation continues its saved session unless session.ts says to start fresh.
function chatResume(announce: boolean, file: string = SESSION_FILE, source: Source = "chat"): Resume {
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

const SEND_DRAFT = "mcp__mailbird__send_message_now";
let draftReader: ((messageId: number) => Promise<DraftView | undefined>) | undefined;
// Set by main.ts: reads a draft back from Mailbird, for the approval of a send.
export const setDraftReader = (fn: typeof draftReader) => void (draftReader = fn);

export function buildOptions(approve: Approve, opts: RunOptions, resume: string | undefined): Options {
  // Permissions as code: policy.ts decides allow / ask / deny; "ask" goes to the owner's phone.
  const canUseTool: CanUseTool = async (tool, input, { signal }) => {
    const verdict = classify(tool, input, opts.source, opts.memory?.dir);
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
    // A small model's second opinion, only for what code puts on the floor (autojudge.ts). In shadow
    // mode it only logs; the owner is asked either way.
    let description = describeCall(tool, input);
    if (tool === SEND_DRAFT) {
      // Show what Mailbird holds right now, not what the model says it is sending. If that cannot
      // be read, the owner would be approving blind, so the send does not happen.
      const id = Number((input as { messageId?: unknown }).messageId);
      const view = draftReader && Number.isFinite(id) ? await draftReader(id).catch(() => undefined) : undefined;
      if (!view || view.to.length === 0) {
        audit(tool, "deny-unreadable-draft", opts.source);
        return { behavior: "deny", message: "That draft could not be read back from Mailbird, so it cannot be shown for approval and was not sent." };
      }
      description = sendApprovalText(view);
    }
    let judged: Verdict | undefined;
    if (settings.autoApprove !== "off" && isJudgeable(tool, input, opts.source)) {
      judged = await judgeAction({ source: opts.source, description, ownerMessage: opts.source === "chat" ? chatOwnerMessage : undefined });
      audit(tool, `judge-${judged.decision}`, opts.source, { reason: judged.reason, mode: settings.autoApprove });
      if (mayAutoApprove(settings.autoApprove, opts.source, judged)) {
        audit(tool, "auto-approved", opts.source, { reason: judged.reason });
        void autoApprovedNotice?.(`✅ Done without asking: ${description.replace(/\n+/g, " | ").slice(0, 300)}`).catch(() => {});
        return { behavior: "allow", updatedInput: input };
      }
    }
    audit(tool, "ask-sent", opts.source); // logged before the wait, so a stuck approval is visible
    const d = await approve(description, { tool, input }, signal);
    if (judged) audit(tool, "judge-vs-owner", opts.source, { judge: judged.decision, ownerApproved: d.approved });
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
  const afterTool = async (tool: string, input: Record<string, unknown>, response?: unknown) => {
    if (opts.memory?.notify && (tool === "Write" || tool === "Edit") && isNotePath(input.file_path) && !isIndex(input.file_path)) {
      const file = basename(input.file_path);
      const written = String((tool === "Write" ? input.content : input.new_string) ?? "");
      const body = parseNote(file, written)?.text ?? written.trim();
      audit("memory_note", tool === "Write" ? "written" : "edited", "chat");
      // The note's own description says what it is; fall back to its first line.
      const described = /^description:\s*["']?(.+?)["']?\s*$/m.exec(written.split(/\n---\n/)[0] ?? "")?.[1];
      const gist = (described ?? body.split("\n")[0]!).slice(0, 160);
      memoryChanges.push(`${tool === "Write" ? "➕ saved" : "✏️ updated"} ${file}: ${gist}`);
    }
    if (changesCalendar(tool)) nudgeRadar();
    opts.onToolSuccess?.(tool, input, response);
  };
  const hooks: Partial<Record<"PostToolUse", HookCallbackMatcher[]>> = {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse") await afterTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, input.tool_response);
            return {};
          },
        ],
      },
    ],
  };

  // A group run: no connectors, no user settings, no skills; its memory server is the only MCP server.
  const isolated = opts.source === "group";
  return {
    model: settings.model,
    outputFormat: opts.outputFormat,
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
    systemPrompt: opts.memory
      ? { type: "preset", preset: "claude_code", append: opts.systemPrompt, snapshot: false }
      : { type: "custom", prompt: opts.systemPrompt, snapshot: false },
    settings: opts.memory ? { autoMemoryEnabled: true, autoMemoryDirectory: opts.memory.dir } : { autoMemoryEnabled: false },
    mcpServers: opts.memory ? { memory: createMemoryServer({ notesDir: opts.memory.dir, groupId: opts.memory.groupId, record: opts.memory.notify ? (line) => memoryChanges.push(line) : () => {} }) } : undefined,
    strictMcpConfig: isolated || undefined, // nothing private is even loaded
    resume,
    // Built-ins: Skill, and for chat Read / Write / Edit (confined to the notes folder by
    // policy.ts) and WebSearch / WebFetch (search freely, open a page only after approval). No Bash. Everything else the agent can do is an MCP tool (Mailbird,
    // Notion, Calendar...), gated by canUseTool.
    tools: isolated ? ["Read", "Write", "Edit", "WebSearch"] : opts.memory ? ["Skill", "Read", "Write", "Edit", "WebSearch", "WebFetch"] : opts.source === "background" ? ["Skill", "WebSearch", "WebFetch"] : ["Skill"],
    // "user" loads user-scope MCP servers (Mailbird) and CLAUDE.md; the skills offered are
    // limited to the bundled ones below.
    // Not "project": there is no project here.
    settingSources: isolated ? [] : ["user"],
    // The bundled skills, loaded from the repo; only these are offered to the model (the owner's
    // other skills would cost context on every call and are none of its business).
    plugins: isolated ? undefined : [{ type: "local", path: settings.pluginDir, skipMcpDiscovery: true }],
    skills: isolated ? undefined : (opts.skills ? [...opts.skills] : OFFERED_SKILLS),
    disallowedTools: isolated ? undefined : hiddenTools(toolsSeen()), // out of the model's view entirely, see policy.ts
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
  let first = false;
  let lastContext: number | undefined; // the last model call of the main loop shows how big the context is
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init" && opts.source !== "group") { // a group run has no connectors: its tool list says nothing about them
      recordToolsSeen(message.tools);
      recordConnectors(message.tools, message.mcp_servers);
    }
    if (message.type === "assistant") {
      if (!first && !message.parent_tool_use_id) (first = true), opts.onFirstOutput?.();
      if (message.error) lastError = message.error;
      if (!message.parent_tool_use_id) lastContext = contextTokens(message.message.usage);
    }
    if (message.type !== "result") continue;
    if (opts.memory?.notify && memoryChanges.length) {
      const lines = memoryChanges.splice(0);
      // The assistant's own reply says what it saved or forgot, and that is the one message. Only if
      // it answered with no words (a bare reaction, or nothing) is a short notice sent instead, so a
      // change never goes unmentioned.
      if (needsMemoryNotice(message.subtype === "success" ? message.result : "")) {
        void opts.memory.notify(`🧠 Memory\n${lines.join("\n")}\nWrong? Tell me to undo it.`).catch(() => {});
      }
    }
    if (opts.sessionFile) {
      const next: ChatSession = { sessionId: message.session_id, costUsd: message.total_cost_usd, lastTurnAt: new Date().toISOString(), lastContextTokens: lastContext, ...(opts.seenAt ? { seenAt: opts.seenAt } : {}) };
      writeJson(opts.sessionFile, next);
    }
    recordCost(message.total_cost_usd - previousCost); // failures cost money too
    if (message.subtype === "success" && !message.is_error) {
      return { text: message.result, costUsd: message.total_cost_usd - previousCost, structured: message.structured_output };
    }
    throw failure(lastError, message.subtype);
  }
  throw new Error("agent stream ended without a result");
}

export async function runAgent(prompt: string, approve: Approve, opts: RunOptions): Promise<AgentReply> {
  const { resume, previousCost } = opts.sessionFile ? chatResume(true, opts.sessionFile) : { resume: undefined, previousCost: 0 };
  return consume(query({ prompt, options: buildOptions(approve, opts, resume) }), opts, previousCost);
}

// A group turn: the group's own resumed session, memory (its notes folder) and tools. `build` makes the prompt
// once it is known whether the session resumes: a resumed one is told only what it has not seen (group.ts).
// No warm process: unlike the owner's chat a group is bursty and many, and a warm Claude Code process per
// group would cost memory for nothing. (The owner's chat keeps one, below.)
export const groupRunOptions = (conv: Pick<Conversation, "notesDir" | "sessionFile" | "groupId">, systemPrompt: string): RunOptions => ({
  source: PROFILES.group.source,
  systemPrompt,
  sessionFile: conv.sessionFile,
  memory: { dir: conv.notesDir, groupId: conv.groupId },
  skills: PROFILES.group.skills,
  maxTurns: PROFILES.group.maxTurns,
  maxBudgetUsd: PROFILES.group.maxBudgetUsd,
});

export async function runGroupTurn(conv: Pick<Conversation, "notesDir" | "sessionFile" | "groupId">, style: string, build: (since?: string) => { prompt: string; seenAt?: string; pictures?: Picture[] }, onFirstOutput?: () => void): Promise<AgentReply> {
  const r = chatResume(true, conv.sessionFile, "group");
  const { prompt, seenAt, pictures } = build(r.resume ? r.seenAt : undefined);
  const o = { ...groupRunOptions(conv, groupSystem({ style })), seenAt, onFirstOutput };
  return consume(query({ prompt: userInput(prompt, pictures), options: buildOptions(async () => ({ approved: false }), o, r.resume) }), o, r.previousCost);
}

// --- a warm process for the next chat message ---
// Only for the owner's chat: at most one warm process exists, and groups never have one.
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
  systemPrompt: chatSystem(readText(LAST_BRIEF), new Date(), missingSetup(readNotes(), down()), down(), recentNotices()),
  sessionFile: SESSION_FILE,
  memory: { dir: NOTES_DIR, notify },
  maxTurns: 40,
  maxBudgetUsd: 2.0, // a cold prompt cache alone can cost most of a dollar
});

// Interactive chat: resumes the persistent conversation, on the warm process when it fits.
export async function ask(prompt: string, approve: Approve, notify: (text: string) => Promise<void>, ownerMessage?: string, pictures: Picture[] = [], hooks?: { firstOutput: () => void }): Promise<AgentReply> {
  chatOwnerMessage = ownerMessage ?? prompt;
  const o = { ...chatOptions(notify), onFirstOutput: hooks?.firstOutput };
  const r = chatResume(true);
  const s = spare;
  spare = undefined; // a warm process serves one query
  if (s && s.key === chatKey(o, r) && Date.now() - s.at < SPARE_MAX_AGE_MS) {
    // Fall back only if the warm process never came up. Once the turn has started, an error
    // is the turn's error: running it again could repeat what it already did.
    const warm = await s.warm.catch((e: Error) => console.error("chat: warm process unavailable, starting normally:", e.message));
    if (warm) return consume(warm.query(userInput(prompt, pictures)), o, r.previousCost);
  } else {
    s?.warm.then((w) => w.close()).catch(() => {});
  }
  return consume(query({ prompt: userInput(prompt, pictures), options: buildOptions(approve, o, r.resume) }), o, r.previousCost);
}

// The owner profiles, as before (the legacy scheduler and the gate's presets both go through runProfile).
export const runBriefTurn = (prompt: string, approve: Approve, onToolSuccess: (tool: string, input: unknown) => void): Promise<AgentReply> => runProfile("brief", prompt, approve, { onToolSuccess });
export const runRadarTurn = (prompt: string, approve: Approve): Promise<AgentReply> => runProfile("radar", prompt, approve);

// Background handling of heartbeat-flagged mail: fresh session, least privilege (see policy.ts).
export function runHandlerTurn(prompt: string, approve: Approve, onToolSuccess?: (tool: string, input: unknown, response?: unknown) => void): Promise<AgentReply> {
  return runAgent(prompt, approve, {
    source: "handler",
    systemPrompt: handlerSystem(memoryFor(["people", "scheduling", "context", "style", "setup", "voice"]), missingSetup(readNotes(), down()), down()),
    maxTurns: 40,
    maxBudgetUsd: 2.0,
    onToolSuccess,
  });
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
export async function compactChatIfNeeded(file: string = SESSION_FILE, source: Source = "chat", notesDir?: string): Promise<void> {
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
