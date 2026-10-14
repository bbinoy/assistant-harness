import { discardJudge, judgeReply, prepareJudge } from "./judge.ts";
import { applyChanges, isModifiable, type Change } from "./policy.ts";
import { settings } from "./settings.ts";
import { audit } from "./audit.ts";
import { judgeAnswer } from "./softjudge.ts";
import type { OpenView, Recent } from "./softprompt.ts";
import { recentChat } from "./recentchat.ts";

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
  outcome: "none" | "approved" | "declined" | "feedback" | "modified" | "clarify";
  changes?: Change[]; // for "modified": what was applied
  reply?: string; // for "clarify": what to tell the owner (the message was consumed; the approval stays open)
  note?: string; // for "none" in soft styles: say this to the owner, and the message still goes on as a normal one
}

// One open question. Kept in `open` keyed by the timestamp of its "Approve?" message (known once the send resolved).
interface Open {
  resolve: (d: Decision) => void;
  label: string;
  call: { tool: string; input: Record<string, unknown> };
  background: boolean; // asked by an unattended run (wake-up, preset, handler): the owner is not in a conversation with it
  ts: number; // 0 until the "Approve?" message is sent
  done: boolean;
  shown: string; // the question text as sent (soft styles: what the judge is shown)
  askedAt: number;
  source: "chat" | "background";
  warmed: boolean; // counted in openChat (holds the shared judge)
}
const open = new Map<number, Open>();
let openChat = 0; // approvals that hold the warm judge (chat ones; in soft styles background ones too): they share the one warm judge
const closed = new Map<number, string>(); // recently ended approvals (timestamp -> label): a quoted reply to one must not land on another

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
export interface SoftDeps {
  judge?: typeof judgeAnswer;
  recent?: (reply: string) => Recent[];
}
export async function answer(text: string, onJudging: () => void, quote?: { timestamp: number }, deps: SoftDeps = {}): Promise<Answer> {
  if (open.size === 0) return { outcome: "none" };
  if (settings.approvalStyle !== "strict") return answerSoft(text, onJudging, quote, deps);
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

const DEFAULT_CLARIFY = (label: string) => `I'm not sure that was a yes, so "${label}" is still open. Say yes or no (or react 👍 / 👎).`;
const whichOne = (os: readonly Open[]) => `Which one do you mean? ${os.map((o, i) => `${i + 1}) ${o.label}`).join("  ")}. Reply to the question itself, or react to it.`;

// APPROVAL_STYLE soft / conversational. The judge reads the reply against ALL open approvals; code keeps only what is unambiguous and
// cheap to check: a quoted reply routes to its approval, and an exact yes / no with exactly one approval open is taken as is.
// Fails closed: no usable judgement means no approval, the message goes on as chat and the owner is told the approvals are still open.
async function answerSoft(text: string, onJudging: () => void, quote: { timestamp: number } | undefined, deps: SoftDeps): Promise<Answer> {
  const live = [...open.values()].filter((o) => !o.done).sort((a, b) => a.ts - b.ts);
  if (live.length === 0) return { outcome: "none" };
  const t = normalise(text);
  const yn = YES.has(t) || NO.has(t);
  const quoted = quote && quote.timestamp !== 0 ? open.get(quote.timestamp) : undefined;
  if (quote && !quoted && closed.has(quote.timestamp) && yn) {
    // A yes to a question that is already gone must not become the answer to another one.
    return { outcome: "clarify", reply: `That question is no longer open. Still open: ${live.map((o) => `"${o.label}"`).join(", ")}.` };
  }
  const direct = quoted && !quoted.done ? quoted : live.length === 1 && !quote ? live[0] : undefined;
  if (direct && yn) {
    audit(direct.call.tool, "answer-fast", direct.source, { reply: text, approved: YES.has(t), question: direct.shown });
    direct.resolve({ approved: YES.has(t) });
    return { outcome: YES.has(t) ? "approved" : "declined" };
  }
  if (text.length > 600) return { outcome: "none" }; // a long message is a new request, not an answer
  const cands = quoted && !quoted.done ? [quoted] : live;
  const ids = new Map(cands.map((o, i) => [`A${i + 1}`, o]));
  const views: OpenView[] = cands.map((o, i) => ({
    id: `A${i + 1}`,
    background: o.background,
    ageMs: Date.now() - o.askedAt,
    question: o.shown,
    args: isModifiable(o.call.tool) ? o.call.input : undefined,
  }));
  onJudging();
  const started = Date.now();
  const j = await (deps.judge ?? judgeAnswer)(text, views, (deps.recent ?? recentChat)(text), quoted && !quoted.done ? "A1" : undefined);
  const stillOpen = () => cands.filter((o) => !o.done);
  const record = (what: string, o?: Open) => audit(o?.call.tool ?? "approval", `answer-${what}`, o?.source ?? "chat", { reply: text, question: o?.shown, verdict: j && `${j.target} ${j.outcome}`, reason: j?.reason, ms: Date.now() - started });
  if (!j) {
    record("failed");
    const left = stillOpen();
    return left.length ? { outcome: "none", note: left.length === 1 ? `I couldn't tell whether that answers "${left[0]!.label}", so it is still open. Reply yes or no, or react 👍 / 👎.` : `I couldn't tell whether that answers one of the ${left.length} open questions, so they are still open. Reply to one, or react 👍 / 👎.` } : { outcome: "none" };
  }
  if (j.outcome === "unrelated") return record("unrelated"), { outcome: "none" };
  if (j.target === "unclear") {
    record("unclear");
    return { outcome: "clarify", reply: j.reply ?? whichOne(stillOpen()) };
  }
  const current = ids.get(j.target);
  if (!current || current.done) return { outcome: "none" }; // resolved or expired while the judge thought
  const clarify = (reply?: string): Answer => (record("clarify", current), { outcome: "clarify", reply: reply ?? DEFAULT_CLARIFY(current.label) });
  const call = current.call;
  if (j.outcome === "decline") {
    record("declined", current);
    current.resolve({ approved: false });
    return { outcome: "declined" };
  }
  if (j.outcome === "other") return clarify(j.reply);
  // Only a short message can consent: a long one is not a yes, whatever the judge made of it.
  if (text.length > 200) return clarify(j.reply);
  if (j.outcome === "approve") {
    record("approved", current);
    current.resolve({ approved: true });
    return { outcome: "approved" };
  }
  const patched = applyChanges(call.tool, call.input, j.changes ?? []);
  if (patched) {
    record("modified", current);
    current.resolve({ approved: true, updatedInput: patched });
    return { outcome: "modified", changes: j.changes };
  }
  record("feedback", current); // a change code does not allow (a recipient): not approved, the agent gets the words and re-proposes
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
  opts: { background?: boolean; question?: string } = {},
): Promise<Decision> {
  if (signal?.aborted) return Promise.resolve({ approved: false });
  const background = !!opts.background;
  const minutes = background ? settings.backgroundApprovalTimeoutMinutes : settings.approvalTimeoutMinutes;
  return new Promise<Decision>((resolve) => {
    const label = description.split("\n")[0] ?? "";
    const shown = opts.question ?? description; // conversational style: a model-written question; the label stays the code's first line
    const finish = (d: Decision, why?: string) => {
      if (entry.done) return;
      entry.done = true;
      if (entry.ts) {
        closed.set(entry.ts, label);
        if (closed.size > 50) closed.delete(closed.keys().next().value!);
      }
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (entry.ts && open.get(entry.ts) === entry) open.delete(entry.ts);
      // The warm judge is shared and single-use: drop it only when no other chat approval is left to use it.
      if (entry.warmed && --openChat === 0) discardJudge();
      if (why) console.log(`approval ${why}: ${label}`);
      resolve(d);
    };
    const warmed = !background || settings.approvalStyle !== "strict"; // soft styles judge every reply, background approvals included
    const entry: Open = { resolve: finish, label, call, background, ts: 0, done: false, shown, askedAt: Date.now(), source: background ? "background" : "chat", warmed };
    const onAbort = () => finish({ approved: false });
    const timer = setTimeout(
      () => finish({ approved: false }, `expired after ${formatWait(minutes)}${background ? " (background)" : ""}`),
      minutes * 60_000,
    );
    signal?.addEventListener("abort", onAbort);
    console.log(`approval requested${background ? " (background)" : ""}: ${label}`);
    if (warmed) {
      openChat++;
      prepareJudge(); // warm the judge while the owner reads the question (strict: a background approval is judged only for a quoted reply: rare)
    }
    const hint = background
      ? "Reply yes or no (or reply to this message to change something)"
      : isModifiable(call.tool) ? "Reply yes, no, or tell me what to change" : "Reply yes or no";
    send(`Approve?\n${shown}\n\n${hint}, or react 👍 / 👎 (${formatWait(minutes)}, then I assume no).`)
      .then((ts) => {
        if (entry.done) return;
        entry.ts = ts;
        open.set(ts, entry);
      })
      .catch(() => finish({ approved: false }));
  });
}
