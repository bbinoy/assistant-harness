import { readText } from "./state.ts";

export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// One pause switch for everything (heartbeat, triage actions, daily brief).
// `touch state/paused` = paused until the file is removed; a date inside (YYYY-MM-DD)
// = paused until that local day, resuming on it. Handy for holidays.
export function isPaused(now = new Date()): boolean {
  const until = readText("paused")?.trim();
  if (until === undefined) return false;
  return until === "" || localDay(now) < until;
}
