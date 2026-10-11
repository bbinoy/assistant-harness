import { appendFile, mkdir, rename, stat } from "node:fs/promises";

// One append-only log for everything the harness does or observes.
//   source: who acted: a chat turn, the heartbeat, or the daily brief run
//   meta:   small structured details. Chat tool calls log tool + decision only;
//           heartbeat entries add ids, sender and subject so the daily brief can list them.
const FILE = new URL("../state/audit.jsonl", import.meta.url);

export type Source = "chat" | "heartbeat" | "brief";

const MAX_BYTES = 20 * 1024 * 1024;
let appends = 0;

export async function audit(
  tool: string,
  decision: string,
  source: Source = "chat",
  meta?: Record<string, unknown>,
) {
  await mkdir(new URL("../state/", import.meta.url), { recursive: true });
  const entry = { ts: new Date().toISOString(), source, tool, decision, ...(meta ? { meta } : {}) };
  await appendFile(FILE, JSON.stringify(entry) + "\n");
  // Keep one previous generation; the digest only ever reads the current file.
  if (++appends % 100 === 0 && (await stat(FILE).catch(() => ({ size: 0 }))).size > MAX_BYTES) {
    await rename(FILE, new URL("../state/audit.jsonl.1", import.meta.url));
  }
}
