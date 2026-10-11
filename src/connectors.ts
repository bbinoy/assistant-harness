import { readJson, writeJson } from "./state.ts";

// Which connectors the last run could actually see. Notion and Google Calendar come through the
// owner's Claude account (settings, then connectors); if one is not connected its tools simply do
// not exist. Knowing that lets the prompts and the brief say "Notion isn't connected" instead of
// the misleading "tasks are not set up", and stops the agent asking the owner to type in what the
// connector would have told it.

const FILE = "state/connectors.json";

export interface Connectors {
  at: string;
  notion: boolean;
  calendar: boolean;
  mail: boolean;
}

export type Connector = "notion" | "calendar";

export const NAMES: Record<Connector, string> = { notion: "Notion", calendar: "Google Calendar" };
// What the owner loses while a connector is down, in plain words.
export const SKIPPED: Record<Connector, string> = { notion: "tasks and meeting prep pages", calendar: "the calendar review and the meeting list" };

// Pure: from the tool names a run was given (hidden tools are not in the list, and the kept
// Notion tools are enough to count).
export function detect(tools: readonly string[], at = new Date()): Connectors {
  const has = (prefix: string) => tools.some((t) => t.startsWith(prefix));
  return { at: at.toISOString(), notion: has("mcp__claude_ai_Notion__"), calendar: has("mcp__claude_ai_Google_Calendar__"), mail: has("mcp__mailbird__") };
}

export const recordConnectors = (tools: readonly string[]) => writeJson(FILE, detect(tools));
export const readConnectors = (): Connectors | undefined => readJson<Connectors | undefined>(FILE, undefined);

// Pure: connectors that were missing in the last run. Unknown (no run yet) counts as fine.
export const disconnected = (c: Connectors | undefined): Connector[] => (c ? (["notion", "calendar"] as const).filter((k) => !c[k]) : []);
