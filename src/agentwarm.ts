import { readFileSync } from "node:fs";
import { startup, type SDKMessage, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { RunTimeout } from "./ceiling.ts";
import { forgetUnresumable, type Resume } from "./chatsession.ts";
import { userInput } from "./image.ts";
import { NOTES_DIR } from "./notes.ts";
import { type Approve } from "./permissions.ts";
import { buildOptions, consume, underCeiling, type AgentReply, type RunOptions } from "./agentrun.ts";
import { settings } from "./settings.ts";
import { firstWarm, SpareSlot } from "./warmslot.ts";

// --- warm processes for the next message ---
// Starting Claude Code (process, config, skills, connectors) takes ~3s before the model is even asked. After a reply the
// next process is started in the background, so the next message only waits for the model. It is used only if nothing it
// was built from has changed (session, prompt, memory index), and only while fresh; otherwise a normal start.
// One mechanism (SpareSlot, warmslot.ts), one idle setting (WARM_IDLE_MINUTES), one switch (WARM): a slot each for the owner's
// chat and the group that spoke last, and the gate's Haiku spare (gate.ts), so at most three processes. A group's is built from
// that group's own options only (its notes folder, session, memory server, no connectors) and is handed to nobody else; the
// owner's has the owner's connectors and is never handed to a group. Options (system prompt, tools, MCP servers, output schema)
// are fixed when a process starts, which is why a slot is keyed by them.
const idleMs = () => settings.warmIdleMinutes * 60_000;
const slotOptions = { maxAgeMs: idleMs(), idleMs }; // fresh while not idle-expired: a process that died meanwhile is detected on use (firstWarm) and replaced
export const spare = new SpareSlot<WarmQuery>(slotOptions);
export const groupSpare = new SpareSlot<WarmQuery>(slotOptions);

const memoryIndex = (dir: string) => {
  try {
    return readFileSync(`${dir}/MEMORY.md`, "utf8");
  } catch {
    return "";
  }
};
const spareKey = (id: string, o: RunOptions, r: Resume) => JSON.stringify([id, r.resume ?? "", o.systemPrompt, o.memory?.dir ?? "", memoryIndex(o.memory?.dir ?? NOTES_DIR)]);

// Starts the next process for a conversation and keeps it as the slot's spare (replacing, and closing, the previous one).
export function warmUp(slot: SpareSlot<WarmQuery>, id: string, o: RunOptions, r: Resume, label: string, approve: Approve, start: typeof startup = startup, refresh = false): void {
  if (!settings.warm) return;
  const warm = start({ options: buildOptions(approve, o, r.resume) });
  warm.catch((e) => console.error(`${label} warm-up failed:`, (e as Error).message));
  slot.put(id, spareKey(id, o, r), warm, { refresh });
}

// One turn: on the slot's warm process when it still fits, else a cold start. A warm process serves one query; one that no
// longer fits is closed. Fall back to a cold start if the warm process is dead or never came up (an idle process can die
// silently): once the turn has produced a message, an error is the turn's error, and running it again could repeat what it did.
export async function runWarmOrCold(slot: SpareSlot<WarmQuery>, id: string | undefined, o: RunOptions, r: Resume, label: string, input: ReturnType<typeof userInput>, cold: (abort: AbortController) => AsyncIterable<SDKMessage>): Promise<AgentReply> {
  try {
    return await underCeiling(o.source, async (c) => {
      const warm = id ? await slot.take(id, spareKey(id, o, r))?.catch((e: Error) => console.error(`${label}: warm process unavailable, starting normally:`, e.message)) : undefined;
      // A warm process is stopped through its query: its abort controller was fixed when it started.
      const onWarm = () => {
        const q = warm!.query(input);
        c.signal.addEventListener("abort", () => q.close(), { once: true });
        return q;
      };
      return consume(warm ? firstWarm(onWarm, () => cold(c.controller), (e) => console.error(`${label}: warm process failed, starting normally:`, e.message)) : cold(c.controller), o, r.previousCost);
    });
  } catch (e) {
    if (e instanceof RunTimeout && id && slot.holder === id) slot.drop(); // after an abort the conversation gets no spare built meanwhile
    if (o.sessionFile) forgetUnresumable(o.sessionFile, e, o.source);
    throw e;
  }
}
