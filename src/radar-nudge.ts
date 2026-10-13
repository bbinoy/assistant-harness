import { emptyState, nudge, type RadarState } from "./radar-rules.ts";
import { readJson, writeJson } from "./state.ts";

export const STATE = "state/radar.json";

// The assistant itself changed the calendar (chat, handler, brief): the radar looks again soon.
export function nudgeRadar(now = new Date()): void {
  writeJson(STATE, nudge(readJson<RadarState>(STATE, emptyState()), now));
}

const CALENDAR_WRITE = /^mcp__claude_ai_Google_Calendar__(create|update|delete)_event$/;
export const changesCalendar = (tool: string): boolean => CALENDAR_WRITE.test(tool);
