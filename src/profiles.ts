import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Source } from "./audit.ts";
import type { Category } from "./notes.ts";
import { RADAR_SCHEMA } from "./radar-rules.ts";

// The only skills the model can load. The SDK enforces this list (anything else is refused with
// "not in this session's skills allowlist"); Skill calls never reach canUseTool.
export const OFFERED_SKILLS = ["daily-brief", "mailbird", "mailbird-troubleshooting", "calendar", "notion-tasks", "meeting-prep", "setup", "radar"].map((s) => `ted-personal-assistant:${s}`);

// ---- run profiles ----
// HOW a run is allowed to work, fixed in code and named: the policy source (policy.ts: which tools are allowed, asked,
// denied), the system prompt, the skills offered, the turn and budget limits and the output schema. A Task (tasks.ts)
// names one; the gate can choose a task but never edit a profile. `notes` are the note categories injected as data.
export type ProfileName = "brief" | "radar" | "background" | "group";
interface RunProfile {
  readonly source: Source;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly skills: readonly string[];
  readonly outputSchema?: Options["outputFormat"];
  readonly notes: readonly Category[];
}
export const PROFILES: Readonly<Record<ProfileName, RunProfile>> = {
  // Unattended daily brief: a fresh session each run, a bigger budget, no banter.
  brief: { source: "brief", maxTurns: 120, maxBudgetUsd: 5.0, skills: OFFERED_SKILLS, notes: ["triage", "people", "scheduling", "context", "brief", "style", "setup", "voice"] },
  // The proactive radar: a fresh session each time; it answers with constrained JSON.
  radar: { source: "radar", maxTurns: 30, maxBudgetUsd: 1.0, skills: OFFERED_SKILLS, outputSchema: RADAR_SCHEMA, notes: ["people", "scheduling", "context", "style", "brief", "setup", "voice"] },
  // An unprompted free-form run in the owner's chat (a wake-up): the radar's rights (reads; anything else asks on the phone),
  // web search allowed (page fetches ask), no memory tools (policy.ts, source "background").
  background: { source: "background", maxTurns: 20, maxBudgetUsd: 1.0, skills: OFFERED_SKILLS, notes: ["people", "scheduling", "context", "style", "brief", "setup", "voice"] },
  // A group's run: its own resumed session, its own notes folder as memory, nothing of the owner's (policy source "group").
  group: { source: "group", maxTurns: 8, maxBudgetUsd: 0.5, skills: OFFERED_SKILLS, notes: [] },
};

export type OwnerProfile = Exclude<ProfileName, "group">;
