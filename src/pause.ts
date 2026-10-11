import { existsSync, readFileSync } from "node:fs";

const PAUSE_FILE = new URL("../state/paused", import.meta.url);

export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// One pause switch for everything (heartbeat, triage actions, daily brief).
// `touch state/paused` = paused until the file is removed; a date inside (YYYY-MM-DD)
// = paused until that local day, resuming on it. Handy for holidays.
export function isPaused(now = new Date()): boolean {
  if (!existsSync(PAUSE_FILE)) return false;
  const until = readFileSync(PAUSE_FILE, "utf8").trim();
  return !until || localDay(now) < until;
}
