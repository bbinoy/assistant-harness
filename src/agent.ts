import { readFileSync } from "node:fs";
import { query, startup, type HookCallbackMatcher, type Options, type SDKMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { audit, type Source } from "./audit.ts";
import { recordCost } from "./budget.ts";
import { pausing, RunTimeout, withCeiling, type Ceiling } from "./ceiling.ts";
import { chatResume, forgetUnresumable, type Resume } from "./chatsession.ts";
import { disconnected, readConnectors, recordConnectors } from "./connectors.ts";
import type { Conversation } from "./conversation.ts";
import { failure } from "./errors.ts";
import { userInput, type Picture } from "./image.ts";
import { createMemoryServer } from "./memory-tools.ts";
import { announceMemoryChanges, noteWritten, recordMemoryChange } from "./memorynotice.ts";
import { LAST_BRIEF, memoryFor, missingSetup, NOTES_DIR, readNotes } from "./notes.ts";
import { DENY_ALL, makeCanUseTool, setChatOwnerMessage, type Approve } from "./permissions.ts";
import { backgroundSystem, briefSystem, chatSystem, groupSystem, handlerSystem, radarSystem } from "./persona.ts";
import { hiddenTools } from "./policy.ts";
import { OFFERED_SKILLS, PROFILES, type OwnerProfile } from "./profiles.ts";
import { changesCalendar, nudgeRadar } from "./radar-nudge.ts";
import { recentNotices } from "./messages.ts";
import { OWNER_SESSION_FILE, type ChatSession } from "./session.ts";
import { settings } from "./settings.ts";
import { cleanToolOutput } from "./toolclean.ts";
import { readJson, readText, writeJson } from "./state.ts";
import { recordToolsSeen, toolsSeen } from "./toolsseen.ts";
import { firstWarm, SpareSlot } from "./warmslot.ts";

interface AgentReply {
  text: string;
  costUsd: number;
  structured?: unknown; // the run's constrained JSON output, when it asked for one
}

interface RunOptions {
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
  judgeContext?: string; // an unattended job: the instructions it was given, shown to the approval judge (autojudge.ts)
}

// Context size of one model call: everything it was sent.
const contextTokens = (u: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) =>
  (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

const down = () => disconnected(readConnectors());

function profileSystem(name: OwnerProfile): string {
  const notes = memoryFor(PROFILES[name].notes);
  const missing = missingSetup(readNotes(), down());
  return name === "brief" ? briefSystem(notes, missing, down()) : name === "radar" ? radarSystem(notes, missing, down()) : backgroundSystem(notes, missing, down());
}

// The options of an owner profile's run (a fresh session).
function profileOptions(name: OwnerProfile, extra: { onToolSuccess?: RunOptions["onToolSuccess"]; judgeContext?: string } = {}): RunOptions {
  const p = PROFILES[name];
  return { source: p.source, systemPrompt: profileSystem(name), skills: p.skills, maxTurns: p.maxTurns, maxBudgetUsd: p.maxBudgetUsd, outputFormat: p.outputSchema, onToolSuccess: extra.onToolSuccess, judgeContext: extra.judgeContext };
}

// One run under a named owner profile: always a fresh session.
export const runProfile = (name: OwnerProfile, prompt: string, approve: Approve, extra: { onToolSuccess?: RunOptions["onToolSuccess"]; judgeContext?: string } = {}): Promise<AgentReply> =>
  runAgent(prompt, approve, profileOptions(name, extra));

export function buildOptions(approve: Approve, opts: RunOptions, resume: string | undefined): Options {
  // After a successful tool call: announce a note change on the phone (chat), and report the
  // call to whoever asked (the brief captures what it sent).
  const afterTool = async (tool: string, input: Record<string, unknown>, response?: unknown) => {
    if (opts.memory?.notify) noteWritten(tool, input);
    if (changesCalendar(tool)) nudgeRadar();
    opts.onToolSuccess?.(tool, input, response);
  };
  const hooks: Partial<Record<"PostToolUse", HookCallbackMatcher[]>> = {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            await afterTool(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, input.tool_response);
            // Clean at the door: the model reads the cleaned result, not the original (counts only in the log).
            const cleaned = cleanToolOutput(input.tool_name, input.tool_response);
            if (!cleaned) return {};
            console.log(`clean: tool result ${input.tool_name}: ${cleaned.removed} hidden character(s) removed, ${cleaned.hidden} hidden HTML part(s) left out, ${cleaned.cut} cut`);
            return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: cleaned.output } };
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
    mcpServers: opts.memory ? { memory: createMemoryServer({ notesDir: opts.memory.dir, groupId: opts.memory.groupId, record: opts.memory.notify ? recordMemoryChange : () => {} }) } : undefined,
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
    canUseTool: makeCanUseTool(approve, opts.source, opts.memory?.dir, opts.judgeContext),
    hooks,
    maxTurns: opts.maxTurns,
    maxBudgetUsd: opts.maxBudgetUsd,
  };
}

// The stream yields many message types (system, assistant, tool use...).
// The one we want is the single "result" message that ends the turn.
async function consume(stream: AsyncIterable<SDKMessage>, opts: RunOptions, previousCost: number): Promise<AgentReply> {
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
    if (opts.memory?.notify) announceMemoryChanges(opts.memory.notify, message.subtype === "success" ? message.result : "");
    if (opts.sessionFile) {
      // The first turn of a session shows what tools, skills and prompts alone cost; later turns keep that baseline (a compaction keeps it too).
      const before = readJson<ChatSession>(opts.sessionFile, { costUsd: 0 });
      const baseTokens = before.sessionId === message.session_id ? before.baseTokens : lastContext; // a session from before this existed has none: the absolute limit applies until it starts fresh
      const next: ChatSession = { sessionId: message.session_id, costUsd: message.total_cost_usd, lastTurnAt: new Date().toISOString(), lastContextTokens: lastContext, ...(baseTokens !== undefined ? { baseTokens } : {}), ...(opts.seenAt ? { seenAt: opts.seenAt } : {}) };
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

// The one place every run passes: chat, groups, wake-ups, brief, radar, the mail handler. On the ceiling the query is aborted, the
// timeout is logged and audited, and the rejection takes the usual error path (a notice, rate-limited in groups; the queue moves on).
// A chat run (the owner's chat and groups alike) and a background run have their own limits (settings.ts).
async function underCeiling<T>(source: Source, run: (c: Ceiling) => Promise<T>): Promise<T> {
  const chat = source === "chat" || source === "group";
  try {
    return await withCeiling((chat ? settings.runMaxMinutesChat : settings.runMaxMinutesBackground) * 60_000, run);
  } catch (e) {
    if (e instanceof RunTimeout) {
      console.error(`run: timed out after ${e.minutes} minutes (${source})`);
      audit("run", "timeout", source, { minutes: e.minutes });
    }
    throw e;
  }
}

export async function runAgent(prompt: string, approve: Approve, opts: RunOptions, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const { resume, previousCost } = opts.sessionFile ? chatResume(true, opts.sessionFile) : { resume: undefined, previousCost: 0 };
  // A background run is always cold, so the approval it waits on belongs to this run and does not count against its ceiling.
  return underCeiling(opts.source, (c) => consume((io.query ?? query)({ prompt, options: { ...buildOptions(pausing(c, approve), opts, resume), abortController: c.controller } }), opts, previousCost)).catch((e) => {
    if (opts.sessionFile) forgetUnresumable(opts.sessionFile, e, opts.source);
    throw e;
  });
}

// --- warm processes for the next message ---
// Starting Claude Code (process, config, skills, connectors) takes ~3s before the model is even asked. After a reply the
// next process is started in the background, so the next message only waits for the model. It is used only if nothing it
// was built from has changed (session, prompt, memory index), and only while fresh; otherwise a normal start.
// One mechanism (SpareSlot, warmslot.ts), one idle setting (WARM_IDLE_MINUTES), one switch (WARM): a slot each for the owner's
// chat and the group that spoke last, and the gate's Haiku spare (gate.ts), so at most three processes. A group's is built from
// that group's own options only (its notes folder, session, memory server, no connectors) and is handed to nobody else; the
// owner's has the owner's connectors and is never handed to a group. Options (system prompt, tools, MCP servers, output schema)
// are fixed when a process starts, which is why a slot is keyed by them.
const idleMs = () => settings.warmIdleMinutes * 60_000;
const slotOptions = { maxAgeMs: idleMs(), idleMs }; // fresh while not idle-expired: a process that died meanwhile is detected on use (firstWarm) and replaced
const spare = new SpareSlot<WarmQuery>(slotOptions);
const groupSpare = new SpareSlot<WarmQuery>(slotOptions);

const memoryIndex = (dir: string) => {
  try {
    return readFileSync(`${dir}/MEMORY.md`, "utf8");
  } catch {
    return "";
  }
};
const spareKey = (id: string, o: RunOptions, r: Resume) => JSON.stringify([id, r.resume ?? "", o.systemPrompt, o.memory?.dir ?? "", memoryIndex(o.memory?.dir ?? NOTES_DIR)]);

// Starts the next process for a conversation and keeps it as the slot's spare (replacing, and closing, the previous one).
function warmUp(slot: SpareSlot<WarmQuery>, id: string, o: RunOptions, r: Resume, label: string, approve: Approve, start: typeof startup = startup, refresh = false): void {
  if (!settings.warm) return;
  const warm = start({ options: buildOptions(approve, o, r.resume) });
  warm.catch((e) => console.error(`${label} warm-up failed:`, (e as Error).message));
  slot.put(id, spareKey(id, o, r), warm, { refresh });
}

// One turn: on the slot's warm process when it still fits, else a cold start. A warm process serves one query; one that no
// longer fits is closed. Fall back to a cold start if the warm process is dead or never came up (an idle process can die
// silently): once the turn has produced a message, an error is the turn's error, and running it again could repeat what it did.
async function runWarmOrCold(slot: SpareSlot<WarmQuery>, id: string | undefined, o: RunOptions, r: Resume, label: string, input: ReturnType<typeof userInput>, cold: (abort: AbortController) => AsyncIterable<SDKMessage>): Promise<AgentReply> {
  try {
    return await underCeiling(o.source, async (c) => {
      const warm = id ? await slot.take(id, spareKey(id, o, r))?.catch((e: Error) => console.error(`${label}: warm process unavailable, starting normally:`, e.message)) : undefined;
      // A warm process is stopped through its query: its abort controller was fixed when it started.
      const onWarm = () => {
        const q = warm!.query(input);
        c.signal.addEventListener("abort", () => q.close(), { once: true });
        return q;
      };
      return consume(warm ? firstWarm(onWarm, () => cold(c.controller), (e) => console.error(`${label}: warm process failed, starting normally:`, e.message)) : cold(c.controller), o, r.previousCost);
    });
  } catch (e) {
    if (e instanceof RunTimeout && id && slot.holder === id) slot.drop(); // after an abort the conversation gets no spare built meanwhile
    if (o.sessionFile) forgetUnresumable(o.sessionFile, e, o.source);
    throw e;
  }
}

// ---- the owner's chat ----

const chatOptions = (notify: (text: string) => Promise<void>): RunOptions => ({
  source: "chat",
  systemPrompt: chatSystem(readText(LAST_BRIEF), new Date(), missingSetup(readNotes(), down()), down(), recentNotices()),
  sessionFile: OWNER_SESSION_FILE,
  memory: { dir: NOTES_DIR, notify },
  maxTurns: 40,
  maxBudgetUsd: 2.0, // a cold prompt cache alone can cost most of a dollar
});

export function prepareChat(approve: Approve, notify: (text: string) => Promise<void>, o: { refresh?: boolean } = {}): void {
  if (o.refresh && !spare.wants("owner")) return; // the timer renews a process in use; it does not keep an idle one alive
  warmUp(spare, "owner", chatOptions(notify), chatResume(false), "chat", approve, startup, o.refresh);
}

// Interactive chat: resumes the persistent conversation, on the warm process when it fits.
export async function ask(prompt: string, approve: Approve, notify: (text: string) => Promise<void>, ownerMessage?: string, pictures: Picture[] = [], hooks?: { firstOutput: () => void }): Promise<AgentReply> {
  setChatOwnerMessage(ownerMessage ?? prompt);
  spare.touch("owner"); // in use: the idle period starts over
  const o = { ...chatOptions(notify), onFirstOutput: hooks?.firstOutput };
  const r = chatResume(true);
  const input = userInput(prompt, pictures);
  return runWarmOrCold(spare, "owner", o, r, "chat", input, (abortController) => query({ prompt: input, options: { ...buildOptions(approve, o, r.resume), abortController } }));
}

// ---- a group's chat ----

// A group turn: the group's own resumed session, memory (its notes folder) and tools.
// Groups are bursty and many, so there is no warm process per group: one is kept for the group that spoke last (above).
type GroupConv = Pick<Conversation, "notesDir" | "sessionFile" | "groupId">;
export const groupRunOptions = (conv: GroupConv, systemPrompt: string): RunOptions => ({
  source: PROFILES.group.source,
  systemPrompt,
  sessionFile: conv.sessionFile,
  memory: { dir: conv.notesDir, groupId: conv.groupId },
  skills: PROFILES.group.skills,
  maxTurns: PROFILES.group.maxTurns,
  maxBudgetUsd: PROFILES.group.maxBudgetUsd,
});

// `build` makes the prompt once it is known whether the session resumes: a resumed one is told only what it has not seen (group.ts).
export async function runGroupTurn(conv: GroupConv, style: string, build: (since?: string) => { prompt: string; seenAt?: string; pictures?: Picture[] }, onFirstOutput?: () => void, io: { query?: typeof query } = {}): Promise<AgentReply> {
  const r = chatResume(true, conv.sessionFile, "group");
  const { prompt, seenAt, pictures } = build(r.resume ? r.seenAt : undefined);
  const o = { ...groupRunOptions(conv, groupSystem({ style })), seenAt, onFirstOutput };
  const input = userInput(prompt, pictures);
  // The group's own warm process, if it is the one kept and nothing it was built from has changed (same group, session, prompt, notes index).
  return runWarmOrCold(groupSpare, conv.groupId, o, r, "group", input, (abortController) => (io.query ?? query)({ prompt: input, options: { ...buildOptions(DENY_ALL, o, r.resume), abortController } }));
}

// Keep ONE warm process for the group that spoke last, replacing another group's. Called when a message arrives for a
// group that may be answered (not if it already holds a fresh one), and after each of its turns (`force`: the session moved on).
// Nothing happens with WARM=off.
export function prepareGroupChat(conv: GroupConv, style: () => string, opts: { force?: boolean; start?: typeof startup } = {}): void {
  const id = conv.groupId;
  if (!settings.warm || !id) return;
  if (!opts.force && groupSpare.has(id)) return void groupSpare.touch(id); // active group, already warm: keep it so
  warmUp(groupSpare, id, groupRunOptions(conv, groupSystem({ style: style() })), chatResume(false, conv.sessionFile, "group"), "group", DENY_ALL, opts.start);
}

// ---- the other owner runs ----

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
