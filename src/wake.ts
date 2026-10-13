import { audit, type Source } from "./audit.ts";
import { inQuietHours } from "./actions.ts";
import { clockLine } from "./brief.ts";
import { budgetSpent } from "./budget.ts";
import { fence } from "./fence.ts";
import { askGate, logTail, lookDue, lookState, NOTHING, notesChangedAt, recordWake, type Gate } from "./gate.ts";
import { groupContext, listGroups } from "./groupstore.ts";
import { groupWakePrompt, mayReply, realRunner, type PromptBuilder, type Runner } from "./group.ts";
import { group, owner, type Conversation, type Pipeline } from "./conversation.ts";
import { ledgerEntries } from "./messages.ts";
import { voiceOption } from "./voicereply.ts";
import { isPaused } from "./pause.ts";
import { OWNER, settings } from "./settings.ts";

// The clock half of the gate (gate.ts). On every heartbeat tick, for the owner's chat and for every group the owner
// is in, whose next look has come (or where something was said or a note changed since the last look), the gate is
// asked whether to do something unprompted. If it says act, the conversation's NORMAL runner does it, with the
// gate's instructions, and the answer goes out through the shared pipeline (it may be [[silent]]):
//   a group    the group run (src/agent.ts runGroupTurn): its own notes and web search, nothing of the owner's
//   the owner  a background run with the radar's rights (policy source "background"): reads, anything else asks on
//              the phone, no web search
// The model decides; THESE are the guards, in code: pause, the daily budget (budgetSpent: asking never uses up the
// owner's once-a-day notice), at most MAX_WAKE_ACTS_PER_DAY acts per conversation, the owner's quiet hours, a group's
// reply cap, and a failed run is logged and silent. A gate that fails or says something odd means do nothing.

export interface WakeDeps {
  pipeline: Pick<Pipeline, "enqueue" | "runTurn" | "record" | "canSpeak">;
  vouch: (groupId: string) => Promise<boolean>; // is the owner in this group? (a group we cannot vouch for is never woken)
  runOwner: (prompt: string) => Promise<{ text: string; costUsd?: number }>; // the owner's background run (agent.ts runBackgroundTurn)
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
  let running = false;

  async function act(conv: Conversation, instructions: string, now: Date): Promise<"posted" | "silent" | "failed" | "skipped"> {
    return pipeline.enqueue(conv, async () => {
      if (conv.groupId && !mayReply(conv.groupId, Date.now())) {
        audit("wake", "rate-limited", "group");
        return "skipped" as const;
      }
      let run: () => Promise<{ text: string; costUsd?: number }>;
      if (conv.kind === "owner") {
        run = () => deps.runOwner(ownerWakePrompt(now, instructions, logTail(conv, 20), pipeline.canSpeak()));
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

  // One conversation, one look. Returns what happened (for the log and tests).
  async function look(conv: Conversation, now: Date): Promise<string> {
    if (conv.kind === "owner" && inQuietHours(now, settings.quietStartHour, settings.quietEndHour)) return "quiet-hours";
    const st = lookState(ledgerEntries(conv.logFile), now);
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
    const instructions = out.instructions?.trim();
    if (!instructions) return "no-instructions"; // a clock look must say what to do
    if (st.actsToday >= settings.maxWakeActsPerDay) {
      audit("wake", "daily-cap", source(conv));
      return "daily-cap";
    }
    if (paused(clock()) || spent()) return "guarded"; // re-checked: the gate call itself took time and money

    const result = await act(conv, instructions, now).catch((e) => (console.error(`wake: ${conv.kind} run failed:`, (e as Error).message), "failed" as const));
    if (result === "skipped") return result;
    // Counts toward the day's cap whether or not it posted, so a failing run cannot loop.
    pipeline.record(conv, "action", Date.now(), `wake-up: ${instructions.slice(0, 200)} → ${result === "posted" ? "posted" : result === "silent" ? "stayed silent" : "failed"}`);
    audit("wake", result, source(conv));
    recordWake(pipeline, conv, out.nextCheckMinutes, now); // after the act: notes it wrote are not news
    return result;
  }

  async function tick(now = clock()): Promise<void> {
    if (!settings.wakeups || running || paused(now) || spent()) return;
    running = true;
    try {
      const convs: Conversation[] = [owner()];
      for (const id of (deps.groups ?? (() => listGroups().map((g) => g.id)))()) if (await deps.vouch(id).catch(() => false)) convs.push(group(id));
      for (const conv of convs) {
        if (paused(clock()) || spent()) break;
        try {
          await look(conv, clock());
        } catch (e) {
          console.error(`wake: ${conv.kind} look failed:`, (e as Error).message);
        }
      }
    } finally {
      running = false;
    }
  }

  return { tick, look };
}
