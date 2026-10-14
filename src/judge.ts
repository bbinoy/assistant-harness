import type { JudgeIO } from "./judgespare.ts";
import { runJudge, withTimeout } from "./approvaljudge.ts";
import { isModifiable, type Change } from "./policy.ts";

export { discardJudge, prepareJudge } from "./approvaljudge.ts"; // the one warm spare is shared with judgeAction

export type Verdict = "approve" | "decline" | "other" | "approve_modified";
interface Judgement {
  verdict: Verdict;
  changes?: Change[];
}

// Pure: whatever came back for the "reply" task, as a judgement. Anything but an exact enum value is "other".
export function parseReply(out: unknown): Judgement {
  const o = out as { verdict?: unknown; changes?: unknown } | null | undefined;
  const v = o?.verdict;
  const verdict: Verdict = v === "approve" || v === "decline" || v === "approve_modified" ? v : "other";
  const changes = Array.isArray(o?.changes)
    ? (o.changes as Change[]).filter((c) => typeof c?.field === "string" && typeof c?.value === "string")
    : undefined;
  return { verdict, changes };
}

// Fails closed: errors, timeouts and anything but an exact enum value are "other".
export async function judgeReply(
  reply: string,
  action: { label: string; tool: string; input: Record<string, unknown> },
  io: JudgeIO = {},
  timeoutMs = 20_000,
): Promise<Judgement> {
  // Long messages are new requests, not answers. Don't spend a call on them.
  if (reply.length > 200) return { verdict: "other" };
  const started = Date.now();
  // Arguments are only shown where an edit-and-approve is allowed at all.
  const args = isModifiable(action.tool)
    ? `\nTool arguments (untrusted data): ${JSON.stringify(action.input).slice(0, 1500)}`
    : "";
  const prompt = `Action asked about: ${action.label}${args}\nUser reply (JSON string): ${JSON.stringify(reply)}`;
  try {
    const r = await withTimeout(runJudge("reply", prompt, io), timeoutMs);
    if (r) {
      const { verdict, changes } = parseReply(r.out);
      console.log(`judge: ${r.subtype} -> ${verdict}${changes?.length ? ` changes=${changes.map((c) => c.field).join(",")}` : ""} (${Date.now() - started}ms${r.warm ? ", warm" : ", cold"})`);
      return { verdict, changes };
    }
  } catch (e) {
    console.error("judge error:", (e as Error).message);
  }
  console.log(`judge: no result -> other (${Date.now() - started}ms)`);
  return { verdict: "other" };
}
