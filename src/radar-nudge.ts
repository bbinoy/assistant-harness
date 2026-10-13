import { FILE as OWNER_LOG, recordMessage, ledgerEntries } from "./messages.ts";
import { ledger } from "./gate.ts";
import { emptyState, MIN_GAP_MINUTES, nudge, type RadarState } from "./radar-rules.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

export const STATE = "state/radar.json";

// The assistant itself changed the calendar (chat, handler, brief): the radar looks again soon.
//   legacy scheduler: the radar's own state pulls its next run forward.
//   gate scheduler:   a line in the owner's log ledger tells the gate ("[nudge] ..."), and the owner's next look is
//                     pulled forward to MIN_GAP_MINUTES from now if it was later.
export function nudgeRadar(now = new Date()): void {
  if (settings.scheduler === "legacy") return void writeJson(STATE, nudge(readJson<RadarState>(STATE, emptyState()), now));
  const entries = ledgerEntries(OWNER_LOG);
  if (entries.some((e) => e.kind === "action" && e.text.startsWith("[nudge]") && now.getTime() - Date.parse(e.at) < MIN_GAP_MINUTES * 60_000)) return; // one per half hour is enough
  recordMessage("action", now.getTime(), ledger.nudge(), now);
  let last: { next: string; looked: string } | undefined;
  for (const e of entries) if (e.kind === "wake") try { last = JSON.parse(e.text); } catch {}
  const soon = now.getTime() + MIN_GAP_MINUTES * 60_000;
  if (!last || !(Date.parse(last.next) <= soon)) recordMessage("wake", now.getTime(), JSON.stringify({ next: new Date(soon).toISOString(), looked: last?.looked ?? now.toISOString() }), now);
}

const CALENDAR_WRITE = /^mcp__claude_ai_Google_Calendar__(create|update|delete)_event$/;
export const changesCalendar = (tool: string): boolean => CALENDAR_WRITE.test(tool);
