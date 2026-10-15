import type { Options } from "@anthropic-ai/claude-agent-sdk";

// The base of every small one-shot model call (triage, notices, the gate, the approval judges, the log summary): Haiku with no tools, no user
// settings and no memory. `tools: []` does NOT stop MCP servers from loading: the owner's claude.ai connectors (109 tools, ~133k tokens)
// came along into every classification, costing $0.16 per cold call instead of $0.0002. Strict MCP mode with no servers keeps the context at
// a few hundred tokens.
export const haikuOptions = (systemPrompt: string, extra: Omit<Options, "model" | "systemPrompt"> = {}): Options => ({
  model: "haiku",
  systemPrompt,
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  settings: { autoMemoryEnabled: false },
  ...extra,
});
