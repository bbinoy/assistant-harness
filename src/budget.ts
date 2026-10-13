import { localDay } from "./pause.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";

// A runaway guard, not an accounting system. Costs are the SDK's own estimates (notional on a
// subscription). Once the day's total passes the ceiling, BACKGROUND work (brief, mail handler)
// stops until tomorrow. Chat stays available: you are in control of that.
// Synchronous on purpose (see state.ts): concurrent recordCost calls can never lose an update.

const FILE = "state/cost.json";

interface Cost {
  day: string;
  usd: number;
  notifiedDay?: string;
}

function today(): Cost {
  const day = localDay(new Date());
  const c = readJson<Cost | undefined>(FILE, undefined);
  return c?.day === day ? c : { day, usd: 0 };
}

export function recordCost(usd: number): void {
  if (!(usd > 0)) return;
  const c = today();
  c.usd += usd;
  writeJson(FILE, c);
}

export function spentToday(): number {
  return today().usd;
}

// `firstTime` is true once per day, so the caller can tell the owner exactly once.
export function overBudget(): { over: boolean; firstTime: boolean; usd: number } {
  const c = today();
  const over = c.usd >= settings.dailyBudgetUsd;
  const firstTime = over && c.notifiedDay !== c.day;
  if (firstTime) writeJson(FILE, { ...c, notifiedDay: c.day });
  return { over, firstTime, usd: c.usd };
}

// Just the question, without the once-a-day "tell the owner" side effect of overBudget (only the code that
// can tell the owner should use that one, or a group message could use up the notice).
export const budgetSpent = (): boolean => today().usd >= settings.dailyBudgetUsd;
