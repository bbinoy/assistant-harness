import { discardJudge, judgeReply, prepareJudge } from "./judge.ts";
import { applyChanges, isModifiable, type Change } from "./policy.ts";
import { settings } from "./settings.ts";

// Human-in-the-loop approvals over Signal. Several questions may be open at once; each is
// answered by its own reaction or quoted reply, or by a plain yes / no for the newest chat one.

// Fast path: exact (normalised) phrases that need no model call.
const YES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "go", "go ahead", "do it",
  "sure go ahead", "yes please", "please do", "approve", "approved", "confirm", "go for it", "👍", "✅",
]);
const NO = new Set([
  "no", "n", "nope", "nah", "stop", "deny", "cancel", "no thanks", "dont", "do not", "👎", "❌",
]);

// lowercase, drop punctuation and apostrophes, collapse spaces (emoji kept).
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// What the open question resolves to. `feedback` is set when the owner replied
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

// One open question. Kept in `open` keyed by the timestamp of its "Approve?" message (known once the send resolved).
interface Open {
  resolve: (d: Decision) => void;
  label: string;
  call: { tool: string; input: Record<string, unknown> };
  background: boolean; // asked by an unattended run (wake-up, preset, handler): the owner is not in a conversation with it
  ts: number; // 0 until the "Approve?" message is sent
  done: boolean;
}
const open = new Map<number, Open>();
let openChat = 0; // chat (non-background) approvals not yet resolved: they share the one warm judge

// "15 min", "2 h", "1 h 30 min".
export function formatWait(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const REACT_YES = new Set(["👍", "✅"]);
const REACT_NO = new Set(["👎", "❌"]);

// A reaction counts only if it is on an open "Approve?" message itself; it answers that one.
export function answerReaction(emoji: string, targetTimestamp: number): "approved" | "declined" | "ignored" {
  const current = open.get(targetTimestamp);
  if (!current || current.done) return "ignored";
  const e = emoji.replace(/[︎️]/g, ""); // drop variation selectors
  if (REACT_YES.has(e)) {
    current.resolve({ approved: true });
    return "approved";
  }
  if (REACT_NO.has(e)) {
    current.resolve({ approved: false });
    return "declined";
  }
  return "ignored";
}

function newestChat(): Open | undefined {
  let best: Open | undefined;
  for (const o of open.values()) if (!o.background && !o.done && (!best || o.ts > best.ts)) best = o;
  return best;
}

// Feed an incoming owner message while approvals may be open. Routing:
//   - a reply that quotes an open approval message answers that one (the only way free text reaches a background approval);
//   - a plain yes / no answers the NEWEST open chat approval, else the only open background one (when exactly one is open);
//   - any other text is judged / taken as feedback by the newest chat approval; background approvals never take it.
// Result: "none" = a normal message; "approved" / "declined" = consumed as the answer; "feedback" = consumed as feedback.
// `onJudging` fires just before the (slower) model judge starts, for an ack.
export async function answer(text: string, onJudging: () => void, quote?: { timestamp: number }): Promise<Answer> {
  if (open.size === 0) return { outcome: "none" };
  const t = normalise(text);
  const yn = YES.has(t) || NO.has(t);
  let target = quote && quote.timestamp !== 0 ? open.get(quote.timestamp) : undefined;
  if (target?.done) target = undefined;
  if (!target) {
    target = newestChat();
    if (!target && yn) {
      const all = [...open.values()].filter((o) => !o.done);
      if (all.length === 1) target = all[0];
    }
  }
  if (!target) return { outcome: "none" };
  const current = target;
  const call = current.call;
  if (YES.has(t)) {
    current.resolve({ approved: true });
    return { outcome: "approved" };
  }
  if (NO.has(t)) {
    current.resolve({ approved: false });
    return { outcome: "declined" };
  }
  onJudging();
  const j = await judgeReply(text, { label: current.label, ...call });
  // Timed out or resolved while the judge was thinking: treat as a normal message.
  if (current.done) return { outcome: "none" };
  if (j.verdict === "approve") {
    current.resolve({ approved: true });
    return { outcome: "approved" };
  }
  if (j.verdict === "decline") {
    current.resolve({ approved: false });
    return { outcome: "declined" };
  }
  if (j.verdict === "approve_modified") {
    const patched = applyChanges(call.tool, call.input, j.changes ?? []);
    if (patched) {
      current.resolve({ approved: true, updatedInput: patched });
      return { outcome: "modified", changes: j.changes };
    }
    // Patch rejected by policy: fall through to feedback, the agent re-proposes.
  }
  current.resolve({ approved: false, feedback: text });
  return { outcome: "feedback" };
}

// Ask the owner. Resolves "not approved" on no, timeout, or an aborted turn. Several may be open at once.
// A chat approval waits APPROVAL_TIMEOUT_MINUTES, a background one BACKGROUND_APPROVAL_TIMEOUT_MINUTES.
export function request(
  send: (text: string) => Promise<number>, // returns the sent message's timestamp
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal?: AbortSignal,
  opts: { background?: boolean } = {},
): Promise<Decision> {
  if (signal?.aborted) return Promise.resolve({ approved: false });
  const background = !!opts.background;
  const minutes = background ? settings.backgroundApprovalTimeoutMinutes : settings.approvalTimeoutMinutes;
  return new Promise<Decision>((resolve) => {
    const label = description.split("\n")[0] ?? "";
    const finish = (d: Decision, why?: string) => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (entry.ts && open.get(entry.ts) === entry) open.delete(entry.ts);
      // The warm judge is shared and single-use: drop it only when no other chat approval is left to use it.
      if (!background && --openChat === 0) discardJudge();
      if (why) console.log(`approval ${why}: ${label}`);
      resolve(d);
    };
    const entry: Open = { resolve: finish, label, call, background, ts: 0, done: false };
    const onAbort = () => finish({ approved: false });
    const timer = setTimeout(
      () => finish({ approved: false }, `expired after ${formatWait(minutes)}${background ? " (background)" : ""}`),
      minutes * 60_000,
    );
    signal?.addEventListener("abort", onAbort);
    console.log(`approval requested${background ? " (background)" : ""}: ${label}`);
    if (!background) {
      openChat++;
      prepareJudge(); // warm the judge while the owner reads the question (a background approval is judged only for a quoted reply: rare)
    }
    const hint = background
      ? "Reply yes or no (or reply to this message to change something)"
      : isModifiable(call.tool) ? "Reply yes, no, or tell me what to change" : "Reply yes or no";
    send(`Approve?\n${description}\n\n${hint}, or react 👍 / 👎 (${formatWait(minutes)}, then I assume no).`)
      .then((ts) => {
        if (entry.done) return;
        entry.ts = ts;
        open.set(ts, entry);
      })
      .catch(() => finish({ approved: false }));
  });
}
