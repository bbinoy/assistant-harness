import { runRadarTurn } from "./agent.ts";
import type { Approve } from "./permissions.ts";
import { audit } from "./audit.ts";
import { inQuietHours } from "./actions.ts";
import { clockLine } from "./brief.ts";
import { overBudget } from "./budget.ts";
import { buildDigest, readTriageSince } from "./digest.ts";
import { fence } from "./fence.ts";
import { isPaused, localDay } from "./pause.ts";
import { recentNotices } from "./messages.ts";
import { acceptMessages, emptyState, isDue, nudge, rollover, scheduleNext, WINDOW_MINUTES, type RadarState } from "./radar-rules.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

// The proactive radar. While the owner is awake, one Sonnet run (adaptive: shortly before the next meeting, at most every RADAR_MINUTES) looks at the
// calendar and at what the heartbeat did, and says what (if anything) deserves an interruption:
// a meeting that is about to start (with its prep), a clash, something the calendar makes urgent.
// The model decides WHAT is worth a message; code (radar-rules.ts) decides whether it may be
// sent: no repeats, a daily cap, a per-run cap. The run is read-only apart from a prep page in
// Notion; calendar changes and sending mail still ask on the phone (policy.ts, source "radar").

import { STATE } from "./radar-nudge.ts";

// The radar preset's instructions (tasks.ts).
export const radarInstructions = (windowMinutes: number): string =>
  `Load the 'ted-personal-assistant:radar' skill with the Skill tool and follow it. Look at the calendar from now until ${windowMinutes} minutes from now for what is about to start, and at the next 24 hours for clashes.`;

export function radarPrompt(now: Date, since: string, windowMinutes: number, digest: string, pings: readonly string[], sentKeys: readonly string[], instructions: string = radarInstructions(windowMinutes)): string {
  return [
    clockLine(now),
    instructions,
    `The heartbeat's work since ${since} (data, for context only):\n${fence("heartbeat_digest", digest || "(nothing)")}`,
    `What you already told the owner on your own in the last day (data, do not repeat it):\n${fence("recent_notifications", pings.join("\n") || "(nothing)")}`,
    `Keys you already sent a message for (never send these again):\n${fence("sent_keys", sentKeys.join("\n") || "(none)")}`,
  ].join("\n\n");
}

export function createRadar(deps: { approve: Approve; notify: (text: string) => Promise<void>; briefDue: () => boolean }) {
  let running = false;

  return async function tick(now = new Date()): Promise<void> {
    if (!settings.proactive || running || isPaused(now)) return;
    if (inQuietHours(now, settings.quietStartHour, settings.quietEndHour)) return;
    if (deps.briefDue()) return; // the daily brief goes first and covers the day
    if (overBudget().over) return;
    const state = rollover(readJson<RadarState>(STATE, emptyState()), localDay(now), now);
    if (!isDue(state, now, settings.radarMinutes)) return;

    running = true;
    // Written before the run: a crash must not mean a retry on every tick.
    writeJson(STATE, { ...state, lastRunAt: now.toISOString() });
    try {
      const since = state.lastRunAt ?? new Date(now.getTime() - settings.radarMinutes * 60_000).toISOString();
      const windowMinutes = WINDOW_MINUTES;
      const started = Date.now();
      const { structured, costUsd } = await runRadarTurn(
        radarPrompt(now, since, windowMinutes, buildDigest(readTriageSince(since), since), recentNotices(now), Object.keys(state.keys)),
        deps.approve,
      );
      const seen = Number((structured as { eventsSeen?: unknown } | undefined)?.eventsSeen ?? 0);
      if (!(seen > 0)) console.error("radar: the run reports it read no calendar events (calendar empty, or it did not look)");
      const messages = acceptMessages(structured, state, settings.maxProactivePerDay);
      let sent = state.sent;
      const keys = { ...state.keys };
      for (const m of messages) {
        try {
          await deps.notify(m.text);
          keys[m.key] = Date.now();
          sent++;
          audit("radar_message", m.kind, "radar", { key: m.key });
        } catch (e) {
          console.error("radar: could not send a message:", (e as Error).message);
        }
      }
      // A calendar change made during the run (a nudge) means the picture is already stale: look again soon.
      const fresh = readJson<RadarState>(STATE, state);
      const nudged = fresh.nudgedAt !== undefined && Date.parse(fresh.nudgedAt) >= now.getTime();
      const next = scheduleNext(new Date(), (structured as { nextStartMinutes?: unknown } | undefined)?.nextStartMinutes, settings.radarMinutes);
      writeJson(STATE, { ...state, lastRunAt: now.toISOString(), sent, keys, nextRunAt: nudged ? nudge({ ...state, lastRunAt: now.toISOString(), nextRunAt: undefined }, new Date()).nextRunAt : next });
      console.log(`radar: ${Math.round((Date.now() - started) / 1000)}s, $${costUsd.toFixed(3)}, ${messages.length} message(s) sent, ${seen} event(s) read`);
      audit("radar_run", messages.length ? "spoke" : "quiet", "radar", { costUsd, messages: messages.length, eventsSeen: seen });
    } catch (e) {
      console.error("radar: run failed:", (e as Error).message);
      audit("radar_run", "failed", "radar", { error: (e as Error).message.slice(0, 200) });
    } finally {
      running = false;
    }
  };
}
