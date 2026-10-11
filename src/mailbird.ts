import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent, fetch as undiciFetch } from "undici";

// Direct MCP client for Mailbird's local server: no model call, no mcp-remote.
// Connection details come from the same entry Claude Code uses, read here so the
// bearer token never passes through a model.
function connectionDetails(): { url: string; headerName: string; headerValue: string } {
  const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.claude.json`, "utf8")).mcpServers?.mailbird;
  const args: string[] = cfg?.args ?? [];
  const url = args.find((a) => a.startsWith("https://127.0.0.1") || a.startsWith("http://127.0.0.1"));
  const header = args[args.indexOf("--header") + 1];
  if (!url || !header) throw new Error("mailbird MCP entry not found in ~/.claude.json");
  const [headerName, ...rest] = header.split(": ");
  return { url, headerName: headerName!, headerValue: rest.join(": ") };
}

export class Mailbird {
  private client: Client | undefined;

  async connect(): Promise<void> {
    const { url, headerName, headerValue } = connectionDetails();
    // Mailbird's cert is self-signed. Verification is off for this one loopback connection only.
    const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { [headerName]: headerValue } },
      fetch: ((u: any, init: any) => undiciFetch(u, { ...init, dispatcher })) as any,
    });
    const client = new Client({ name: "agent-harness", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async listTools() {
    return (await this.client!.listTools()).tools;
  }

  // Calls a tool and returns parsed JSON when the result is JSON text, else the raw text.
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) await this.connect();
    // A hung call must not stall the heartbeat forever: fail after 60s, reconnect next time.
    const res: any = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const text: string = res.content?.find((c: any) => c.type === "text")?.text ?? "";
    if (res.isError) throw new Error(`mailbird ${name} failed: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async close() {
    await this.client?.close();
    this.client = undefined;
  }
}
