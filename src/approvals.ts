import { discardJudge, judgeReply, prepareJudge } from "./judge.ts";
import { applyChanges, isModifiable, type Change } from "./policy.ts";

// Human-in-the-loop approvals over Signal. At most one question is pending at a
// time; concurrent requests (parallel tool calls) wait their turn.

// Fast path: exact (normalised) phrases that need no model call.
const YES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "go", "go ahead", "do it",
  "sure go ahead", "yes please", "please do", "approve", "approved", "confirm", "go for it", "👍", "✅",
]);
const NO = new Set([
  "no", "n", "nope", "nah", "stop", "deny", "cancel", "no thanks", "dont", "do not", "👎", "❌",
]);
const TIMEOUT_MS = 5 * 60_000;

// lowercase, drop punctuation and apostrophes, collapse spaces (emoji kept).
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// What the pending question resolves to. `feedback` is set when the owner replied
// with something other than a clear yes/no: the agent gets it as the reason for
// the denial and can act on it in the same turn (e.g. "yes but make it 16:00").
export interface Decision {
  approved: boolean;
  feedback?: string;
  updatedInput?: Record<string, unknown>; // set when approved with an accepted edit
}

export interface Answer {
  outcome: "none" | "approved" | "declined" | "feedback" | "modified";
  changes?: Change[]; // for "modified": what was applied
}

let pending: ((d: Decision) => void) | undefined;
let pendingLabel = "";
let pendingTimestamp = 0; // timestamp of the "Approve?" message, what a reaction must target
let pendingBackground = false; // asked by an unattended run (wake-up, preset, handler): the owner is not in a conversation with it
let pendingCall: { tool: string; input: Record<string, unknown> } | undefined;
let chain: Promise<unknown> = Promise.resolve();

const REACT_YES = new Set(["👍", "✅"]);
const REACT_NO = new Set(["👎", "❌"]);

// A reaction counts only if it is on the pending "Approve?" message itself.
export function answerReaction(emoji: string, targetTimestamp: number): "approved" | "declined" | "ignored" {
  const current = pending;
  if (!current || targetTimestamp !== pendingTimestamp) return "ignored";
  const e = emoji.replace(/[\uFE0E\uFE0F]/g, ""); // drop variation selectors
  if (REACT_YES.has(e)) {
    current({ approved: true });
    return "approved";
  }
  if (REACT_NO.has(e)) {
    current({ approved: false });
    return "declined";
  }
  return "ignored";
}

// Feed an incoming owner message while an approval may be pending.
//   "none"      - nothing pending (or the pending one is a background approval and this is not an answer to it): a normal message
//   "approved" / "declined" - consumed as the answer
//   "feedback"  - consumed as feedback on the denied call
// `onJudging` fires just before the (slower) model judge starts, for an ack.
// `quote`: the message the owner's message replies to. A BACKGROUND approval (nobody is chatting with that run) answers only to
// an explicit yes / no / 👍 / 👎 or to a reply that quotes the approval message itself; every other message is chat and must
// get a chat answer, not be swallowed as feedback on a call the owner never saw coming.
export async function answer(text: string, onJudging: () => void, quote?: { timestamp: number }): Promise<Answer> {
  const current = pending;
  const call = pendingCall;
  if (!current || !call) return { outcome: "none" };
  const t = normalise(text);
  if (pendingBackground && !YES.has(t) && !NO.has(t) && !(quote && pendingTimestamp !== 0 && quote.timestamp === pendingTimestamp)) return { outcome: "none" };
  if (YES.has(t)) {
    current({ approved: true });
    return { outcome: "approved" };
  }
  if (NO.has(t)) {
    current({ approved: false });
    return { outcome: "declined" };
  }
  onJudging();
  const j = await judgeReply(text, { label: pendingLabel, ...call });
  // Timed out or resolved while the judge was thinking: treat as a normal message.
  if (pending !== current) return { outcome: "none" };
  if (j.verdict === "approve") {
    current({ approved: true });
    return { outcome: "approved" };
  }
  if (j.verdict === "decline") {
    current({ approved: false });
    return { outcome: "declined" };
  }
  if (j.verdict === "approve_modified") {
    const patched = applyChanges(call.tool, call.input, j.changes ?? []);
    if (patched) {
      current({ approved: true, updatedInput: patched });
      return { outcome: "modified", changes: j.changes };
    }
    // Patch rejected by policy: fall through to feedback, the agent re-proposes.
  }
  current({ approved: false, feedback: text });
  return { outcome: "feedback" };
}

// Ask the owner. Resolves "not approved" on no, timeout, or an aborted turn.
export function request(
  send: (text: string) => Promise<number>, // returns the sent message's timestamp
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal?: AbortSignal,
  opts: { background?: boolean } = {},
): Promise<Decision> {
  const run = async (): Promise<Decision> => {
    if (signal?.aborted) return { approved: false };
    return new Promise<Decision>((resolve) => {
      const finish = (d: Decision) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending = undefined;
        pendingLabel = "";
        pendingTimestamp = 0;
        pendingCall = undefined;
        pendingBackground = false;
        discardJudge();
        resolve(d);
      };
      const onAbort = () => finish({ approved: false });
      const timer = setTimeout(() => finish({ approved: false }), TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort);
      pending = finish;
      pendingLabel = description.split("\n")[0] ?? "";
      pendingCall = call;
      pendingBackground = !!opts.background;
      console.log(`approval requested: ${pendingLabel}`);
      if (!opts.background) prepareJudge(); // warm the judge while the owner reads the question (a background approval is judged only for a quoted reply: rare)
      const hint = opts.background
        ? "Reply yes or no (or reply to this message to change something)"
        : isModifiable(call.tool) ? "Reply yes, no, or tell me what to change" : "Reply yes or no";
      send(`Approve?\n${description}\n\n${hint}, or react 👍 / 👎 (5 min, then I assume no).`)
        .then((ts) => {
          if (pending === finish) pendingTimestamp = ts;
        })
        .catch(() => finish({ approved: false }));
    });
  };
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  return result;
}
