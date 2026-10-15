import { query, startup } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, runAgent, type AgentReply, type RunOptions } from "./agentrun.ts";
import { groupSpare, runWarmOrCold, spare, warmUp } from "./agentwarm.ts";
import { OWNER_TELL, withTell, type TellSink } from "./telluser.ts";
import { chatResume } from "./chatsession.ts";
import { disconnected, readConnectors } from "./connectors.ts";
import type { Conversation } from "./conversation.ts";
import { userInput, type Picture } from "./image.ts";
import { LAST_BRIEF, memoryFor, missingSetup, NOTES_DIR, readNotes } from "./notes.ts";
import { approveInGroup, setChatOwnerMessage, type Approve } from "./permissions.ts";
import { backgroundSystem, briefSystem, chatSystem, groupSystem, handlerSystem, radarSystem } from "./persona.ts";
import { PROFILES, type OwnerProfile } from "./profiles.ts";
import { recentNotices } from "./messages.ts";
import { OWNER_SESSION_FILE } from "./session.ts";
import { settings } from "./settings.ts";
import { readText } from "./state.ts";

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
  warmUp(spare, "owner", chatOptions(notify), chatResume(), "chat", approve, startup, o.refresh);
}

// Interactive chat: resumes the persistent conversation, on the warm process when it fits.
export async function ask(prompt: string, approve: Approve, notify: (text: string) => Promise<void>, ownerMessage?: string, pictures: Picture[] = [], hooks?: { firstOutput: () => void; tell?: TellSink }): Promise<AgentReply> {
  setChatOwnerMessage(ownerMessage ?? prompt);
  spare.touch("owner"); // in use: the idle period starts over
  const o = { ...chatOptions(notify), onFirstOutput: hooks?.firstOutput };
  const r = chatResume();
  const input = userInput(prompt, pictures);
  return withTell(OWNER_TELL, hooks?.tell, () => runWarmOrCold(spare, "owner", o, r, "chat", input, (abortController) => query({ prompt: input, options: { ...buildOptions(approve, o, r.resume), abortController } })));
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
export async function runGroupTurn(conv: GroupConv, style: string, build: (since?: string) => { prompt: string; seenAt?: string; pictures?: Picture[] }, onFirstOutput?: () => void, io: { query?: typeof query } = {}, tell?: TellSink): Promise<AgentReply> {
  const r = chatResume(conv.sessionFile);
  const { prompt, seenAt, pictures } = build(r.resume ? r.seenAt : undefined);
  const o = { ...groupRunOptions(conv, groupSystem({ style })), seenAt, onFirstOutput };
  const input = userInput(prompt, pictures);
  // The group's own warm process, if it is the one kept and nothing it was built from has changed (same group, session, prompt, notes index).
  return withTell(conv.groupId!, tell, () => runWarmOrCold(groupSpare, conv.groupId, o, r, "group", input, (abortController) => (io.query ?? query)({ prompt: input, options: { ...buildOptions(approveInGroup(conv.groupId!), o, r.resume), abortController } })));
}

// Keep ONE warm process for the group that spoke last, replacing another group's. Called when a message arrives for a
// group that may be answered (not if it already holds a fresh one), and after each of its turns (`force`: the session moved on).
// Nothing happens with WARM=off.
export function prepareGroupChat(conv: GroupConv, style: () => string, opts: { force?: boolean; start?: typeof startup } = {}): void {
  const id = conv.groupId;
  if (!settings.warm || !id) return;
  if (!opts.force && groupSpare.has(id)) return void groupSpare.touch(id); // active group, already warm: keep it so
  warmUp(groupSpare, id, groupRunOptions(conv, groupSystem({ style: style() })), chatResume(conv.sessionFile), "group", approveInGroup(id), opts.start);
}

// ---- the other owner runs ----

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

