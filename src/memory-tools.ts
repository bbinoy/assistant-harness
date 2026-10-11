import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit } from "./audit.ts";
import { forgetNote } from "./notes.ts";

// The SDK's auto-memory lets the chat agent create and edit notes with ordinary file tools
// (limited to memory/notes/ by policy.ts), but it has no way to delete one. This is that: an
// in-process MCP tool, chat only. Like every note change it is announced on the phone (agent.ts).
// Audit lines carry the outcome, never the text.

const reply = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });

export function createMemoryServer(record: (line: string) => void) {
  return createSdkMcpServer({
    name: "memory",
    version: "2.0.0",
    tools: [
      tool(
        "forget_note",
        "Delete one memory note, and its line in MEMORY.md. Only when the OWNER asked you to forget it. The owner is told on their phone automatically; do not repeat that in your reply.",
        { file: z.string().describe("The note's file name, like style-no-em-dashes.md") },
        async ({ file }) => {
          const r = forgetNote(file);
          audit("memory_forget", r.ok ? "removed" : "not-removed", "chat");
          if (!r.ok) return reply(r.error, true);
          record(`➖ forgot ${file}`);
          return reply(`Forgot ${file}.`);
        },
      ),
    ],
  });
}
