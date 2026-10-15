import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// tell_user: lets the model say something to the person NOW while it keeps working ("On it, researching now"). Text the
// model writes before a tool call stays internal; only this tool sends. The owner's chat and groups have it; unattended
// runs (brief, radar, handler, browse worker, dream, compaction, wake-ups) do not (agent.ts, toolmanifest.ts).
// Delivery is the conversation's own (conversation.ts runTurn): same sanitiser, target and quote rules, [[silent]] sends
// nothing. How often to use it is the model's call; the run's turn, budget and time limits bound a runaway loop.

// Sends one interim message of the running turn; returns what the model is told.
export type TellSink = (text: string) => Promise<string>;

export const OWNER_TELL = "owner";

// Warm processes are built before their turn exists, so the server looks the turn's sink up when called.
const sinks = new Map<string, TellSink>();

export async function withTell<T>(key: string, sink: TellSink | undefined, run: () => Promise<T>): Promise<T> {
  if (!sink) return run();
  sinks.set(key, sink);
  try {
    return await run();
  } finally {
    if (sinks.get(key) === sink) sinks.delete(key);
  }
}

export function createTellServer(key: string) {
  return createSdkMcpServer({
    name: "tell",
    version: "1.0.0",
    tools: [
      tool(
        "tell_user",
        "Send a short message to the person right now while you keep working, for example \"On it, researching now.\" Use it once at the start of a longer task (research, browsing, several lookups), in their language and your usual voice, and again only if the work is genuinely long. Not for quick answers, not for trivial steps, and never for the result itself: that is your final reply.",
        { message: z.string().min(1).max(500).describe("One short line, as you would write it in the chat.") },
        async ({ message }) => {
          const sink = sinks.get(key);
          const text = sink ? await sink(message).catch(() => "Could not send it; carry on.") : "Nobody to tell right now; carry on.";
          return { content: [{ type: "text" as const, text }] };
        },
      ),
    ],
  });
}
