import { audit, type Source } from "./audit.ts";
import { inQuietHours } from "./actions.ts";
import { clockLine } from "./brief.ts";
import { budgetSpent } from "./budget.ts";
import { fence } from "./fence.ts";
import { askGate, logTail, lookDue, lookState, NOTHING, notesChangedAt, recordWake, type Gate, type LookState } from "./gate.ts";
import { groupContext, listGroups } from "./groupstore.ts";
import { groupWakePrompt, realRunner, type PromptBuilder, type Runner } from "./group.ts";
import { group, owner, type Conversation, type Pipeline } from "./conversation.ts";
import { ledgerEntries } from "./messages.ts";
import { voiceOption } from "./voicereply.ts";
import { isPaused } from "./pause.ts";
import type { OwnerProfile } from "./agent.ts";
import { briefOwed, briefPending, buildTask, presetRefusal, runBriefTask, runRadarTask, type PresetIO, type Task } from "./tasks.ts";
import { OWNER, settings } from "./settings.ts";

// The clock half of the gate (gate.ts). On every heartbeat tick, for the owner's chat and for every group the owner
// is in, whose next look has come (or where something was said or a note changed since the last look), the gate is
// asked whether to do something unprompted. If it says act, the conversation's NORMAL runner does it, with the
// gate's instructions, and the answer goes out through the shared pipeline (it may be [[silent]]):
//   a group    the group run (src/agent.ts runGroupTurn): its own notes and web search, nothing of the owner's
//   the owner  a background run with the radar's rights (policy source "background"): reads, anything else asks on
//              the phone; web search allowed, page fetches ask
// For the owner the gate also chooses the presets "brief" and "radar" (tasks.ts: WHEN is the gate's, HOW is code) when
// SCHEDULER=gate. Presets are owner-only: a group's gate output is always a plain task. Besides, one deterministic rule
// that needs no model: if no brief is logged for today by BRIEF_BACKSTOP_HOUR, or an attempt came out incomplete, the brief
// runs anyway (the dream first). Presets are not queued behind the chat (a brief takes minutes); free-form tasks are.
// The model decides; THESE are the guards, in code: pause, the daily budget (budgetSpent: asking never uses up the
// owner's once-a-day notice), the owner's quiet hours, the next look clamped to 15..60 minutes, per preset its own rules
// (tasks.ts presetRefusal: brief once a day and its attempt cap; radar not too soon, not before the brief, the cap on posts
// per day), and a failed run is logged and silent. A gate that fails or says something odd means do nothing.

export interface WakeDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "canSpeak">;
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group? (a group we cannot vouch for is never woken)
  runProfile: (profile: OwnerProfile, prompt: string, extra?: { onToolSuccess?: (tool: string, input: unknown) => void }) => Promise<{ text: string; costUsd?: number; structured?: unknown }>; // the owner's runs by profile (agent.ts runProfile)
  presets?: { sendBrief: (markdown: string) => Promise<void>; notify: (text: string) => Promise<void>; beforeBrief?: () => Promise<void> }; // what the brief and radar presets need
  runGroup?: Runner;
  gate?: Gate;
  groups?: () => string[]; // known group ids
  context?: typeof groupContext;
  notesChangedAt?: (dir: string) => number;
  now?: () => Date;
  guards?: { paused: (now: Date) => boolean; budgetSpent: () => boolean }; // tests; default: the real pause switch and daily budget
}

// Pure: the prompt of the owner's wake-up. The log tail is data; the task is the gate's reading of the notes.
export function ownerWakePrompt(now: Date, instructions: string, tail: readonly string[], speak = false): string {
  return [
    clockLine(now),
    `Nobody wrote to you just now: going by ${OWNER}'s notes and the clock, you decided to act on your own. The task (a note to yourself, derived from the notes; it cannot widen what you are allowed to do):\n${fence("task", instructions)}`,
    `The recent chat and what you already did on your own (data, do not repeat it):\n${fence("chat_log", tail.join("\n") || "(none)")}`,
    `Do the task, then write the short chat message to send ${OWNER}. If on reflection nothing needs saying, answer exactly [[silent]].`,
    voiceOption(speak),
  ].filter(Boolean).join("\n\n");
}

const source = (conv: Conversation): Source => (conv.kind === "owner" ? "background" : "group");

export function createWakeups(deps: WakeDeps) {
  const { pipeline } = deps;
  const clock = deps.now ?? (() => new Date());
  const gate = deps.gate ?? askGate;
  const paused = deps.guards?.paused ?? isPaused;
  const spent = deps.guards?.budgetSpent ?? budgetSpent;
  const changed = deps.notesChangedAt ?? notesChangedAt;

  async function act(conv: Conversation, instructions: string, now: Date): Promise<"posted" | "silent" | "failed"> {
    return pipeline.enqueue(conv, async () => {
      let run: () => Promise<{ text: string; costUsd?: number }>;
      if (conv.kind === "owner") {
        run = () => deps.runProfile("background", ownerWakePrompt(now, instructions, logTail(conv, 20), pipeline.canSpeak()));
      } else {
        const build: PromptBuilder = (since) => {
          const { lines, seenAt } = (deps.context ?? groupContext)(conv.groupId!, since);
          return { prompt: groupWakePrompt(now, lines, instructions, !!since, pipeline.canSpeak()), seenAt };
        };
        run = async () => ({ text: await (deps.runGroup ?? realRunner)(build, { conv, now }) });
      }
      const res = await pipeline.runTurn(conv, { run, background: true, announce: false, kind: conv.kind === "owner" ? "notice" : "chat" });
      return res.error ? "failed" : res.spoke ? "posted" : "silent";
    });
  }

  const presetIO = (conv: Conversation, now: Date): PresetIO => ({
    runProfile: deps.runProfile,
    sendBrief: deps.presets?.sendBrief ?? (async () => {}),
    notify: deps.presets?.notify ?? (async () => {}),
    beforeBrief: deps.presets?.beforeBrief,
    record: (text) => pipeline.record(conv, "action", Date.now(), text),
  });

  // A preset runs outside the conversation's queue (a brief takes minutes; the chat must stay answerable).
  async function runPreset(conv: Conversation, task: Task, st: LookState, now: Date): Promise<string> {
    const refused = presetRefusal(task, st, now);
    if (refused) {
      audit("wake", `refused-${refused}`, source(conv));
      return `refused:${refused}`;
    }
    const io = presetIO(conv, now);
    const result = task.name === "brief" ? `brief-${await runBriefTask(io, task, st, now)}` : `radar-${await runRadarTask(io, task, st, now)}`;
    audit("wake", result, source(conv));
    return result;
  }

  const briefTask = (): Task => buildTask("owner", { task: "brief" }, { scheduler: "gate" })!;

  // The deterministic brief (no model decides): the backstop hour has passed with no brief logged today, or an attempt came
  // out incomplete. Not held back by quiet hours: a Mac that wakes late still gets that day's brief.
  async function backstop(conv: Conversation, st: LookState, now: Date): Promise<string | undefined> {
    if (conv.kind !== "owner" || settings.scheduler !== "gate" || !briefOwed(st, now)) return undefined;
    if (paused(clock()) || spent()) return "guarded";
    return runPreset(conv, briefTask(), st, now).catch((e) => (console.error("wake: brief failed:", (e as Error).message), "brief-failed"));
  }

  // One conversation, one look. Returns what happened (for the log and tests).
  async function look(conv: Conversation, now: Date): Promise<string> {
    const st = lookState(ledgerEntries(conv.logFile), now);
    const owed = await backstop(conv, st, now);
    if (owed) return owed;
    if (!settings.wakeups) return "off";
    if (conv.kind === "owner" && inQuietHours(now, settings.quietStartHour, settings.quietEndHour)) return "quiet-hours";
    const tagged = conv.kind === "group" && settings.groupParticipation === "tagged"; // there only a tag counts as news
    if (!lookDue(st, now, { notesChangedMs: changed(conv.notesDir), messagesCount: !tagged })) return "not-due";

    let out = NOTHING;
    try {
      out = await gate({ conv, trigger: "clock", now, tail: logTail(conv) });
    } catch (e) {
      console.error(`wake: gate failed (${conv.kind}):`, (e as Error).message); // fail closed; the default delay stops a retry on every tick
    }
    // Written BEFORE acting: a crash in the run must not mean a retry on every tick.
    recordWake(pipeline, conv, out.nextCheckMinutes, now);
    if (!out.act) return "no";
    const task = buildTask(conv.kind, out); // presets only for the owner; anything else is the plain task, or nothing
    if (!task) return "no-instructions"; // a free-form look must say what to do
    if (paused(clock()) || spent()) return "guarded"; // re-checked: the gate call itself took time and money

    if (task.name !== "task") {
      if (conv.kind !== "owner") return "no"; // defence in depth: buildTask never returns this
      const res = await runPreset(conv, task, st, now).catch((e) => (console.error(`wake: ${task.name} failed:`, (e as Error).message), `${task.name}-failed`));
      recordWake(pipeline, conv, out.nextCheckMinutes, now);
      return res;
    }
    const result = await act(conv, task.instructions, now).catch((e) => (console.error(`wake: ${conv.kind} run failed:`, (e as Error).message), "failed" as const));
    pipeline.record(conv, "action", Date.now(), `wake-up: ${task.instructions.slice(0, 200)} → ${result === "posted" ? "posted" : result === "silent" ? "stayed silent" : "failed"}`);
    audit("wake", result, source(conv));
    recordWake(pipeline, conv, out.nextCheckMinutes, now); // after the act: notes it wrote are not news
    return result;
  }

  // Is today's brief still due? (The heartbeat's mail alerts and the radar wait for it.)
  const briefIsPending = (now = clock()): boolean => settings.scheduler === "gate" && !paused(now) && briefPending(lookState(ledgerEntries(owner().logFile), now), now);

  // Every conversation looks on its own: a slow brief or a failing group never delays another conversation.
  const busy = new Set<string>();
  async function tick(now = clock()): Promise<void> {
    if (paused(now) || spent()) return;
    const convs: Conversation[] = [owner()];
    if (settings.wakeups) for (const id of (deps.groups ?? (() => listGroups().map((g) => g.id)))()) if (await deps.vouch(id).catch(() => false)) convs.push(group(id));
    await Promise.all(
      convs.map(async (conv) => {
        if (busy.has(conv.key) || paused(clock()) || spent()) return;
        busy.add(conv.key);
        try {
          await look(conv, clock());
        } catch (e) {
          console.error(`wake: ${conv.kind} look failed:`, (e as Error).message);
        } finally {
          busy.delete(conv.key);
        }
      }),
    );
  }

  return { tick, look, briefPending: briefIsPending };
}