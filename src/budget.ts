import { mkdir, readFile, writeFile } from "node:fs/promises";
import { localDay } from "./pause.ts";

// A runaway guard, not an accounting system. Costs are the SDK's own estimates (notional on a
// subscription). Once the day's total passes the ceiling, BACKGROUND work (brief retries, the
// mail handler) stops until tomorrow. Chat stays available: you are in control of that.
const FILE = new URL("../state/cost.json", import.meta.url);
export const DAILY_LIMIT_USD = Number(process.env.DAILY_BUDGET_USD ?? 20);

interface Cost {
  day: string;
  usd: number;
  notifiedDay?: string;
}

async function load(): Promise<Cost> {
  try {
    const c = JSON.parse(await readFile(FILE, "utf8")) as Cost;
    return c.day === localDay(new Date()) ? c : { day: localDay(new Date()), usd: 0, notifiedDay: c.notifiedDay };
  } catch {
    return { day: localDay(new Date()), usd: 0 };
  }
}

async function save(c: Cost) {
  await mkdir(new URL("../state/", import.meta.url), { recursive: true });
  await writeFile(FILE, JSON.stringify(c));
}

export async function recordCost(usd: number) {
  if (!(usd > 0)) return;
  const c = await load();
  c.usd += usd;
  await save(c);
}

export async function spentToday(): Promise<number> {
  return (await load()).usd;
}

// True when background work must not start. `firstTime` is true once per day, so the caller can tell the owner once.
export async function overBudget(): Promise<{ over: boolean; firstTime: boolean; usd: number }> {
  const c = await load();
  const over = c.usd >= DAILY_LIMIT_USD;
  const firstTime = over && c.notifiedDay !== c.day;
  if (firstTime) await save({ ...c, notifiedDay: c.day });
  return { over, firstTime, usd: c.usd };
}
