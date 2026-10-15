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
  failure?: string; // the approval could not be run (no question could be written, the reply could not be read): nothing was approved, the agent is told why and decides what to do
}

export interface Answer {
  outcome: "none" | "approved" | "declined" | "feedback" | "modified" | "clarify";
  changes?: Change[]; // for "modified": what was applied
  reply?: string; // for "clarify": what to tell the owner (the message was consumed; the approval stays open)
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
  source: "chat" | "background" | "group";
  warmed: boolean; // counted in openChat (holds the shared judge)
  scope: string; // the conversation it was asked in (Conversation.key): an answer from another conversation never applies
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
export const OWNER_SCOPE = "owner";
export function answerReaction(emoji: string, targetTimestamp: number, scope: string = OWNER_SCOPE, by?: string): "approved" | "declined" | "ignored" {
  const current = open.get(targetTimestamp);
  if (!current || current.done || current.scope !== scope) return "ignored";
  const e = emoji.replace(/[︎️]/g, ""); // drop variation selectors
  if (REACT_YES.has(e) || REACT_NO.has(e)) {
    if (settings.approvalStyle !== "strict") audit(current.call.tool, "answer-reaction", current.source, { by, scope, approved: REACT_YES.has(e), question: current.shown });
    current.resolve({ approved: REACT_YES.has(e) });
    return REACT_YES.has(e) ? "approved" : "declined";
  }
  return "ignored";
}

function newestChat(mine: readonly Open[]): Open | undefined {
  let best: Open | undefined;
  for (const o of mine) if (!o.background && !o.done && (!best || o.ts > best.ts)) best = o;
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
// `scope`: the conversation the message arrived in; only approvals asked there can be answered. `by`: who wrote it (audit).
// `voice`: the text is an automatic transcript of a voice message.
export interface Ctx {
  scope?: string;
  by?: string;
  voice?: boolean;
}
export async function answer(text: string, onJudging: () => void, quote?: { timestamp: number }, deps: SoftDeps = {}, ctx: Ctx = {}): Promise<Answer> {
  const scope = ctx.scope ?? OWNER_SCOPE;
  const mine = [...open.values()].filter((o) => o.scope === scope && !o.done);
  if (mine.length === 0) return { outcome: "none" };
  if (settings.approvalStyle !== "strict") return answerSoft(text, onJudging, quote, deps, ctx, mine);
  const t = normalise(text);
  const yn = YES.has(t) || NO.has(t);
  let target = quote && quote.timestamp !== 0 ? open.get(quote.timestamp) : undefined;
  if (target?.done || target?.scope !== scope) target = undefined;
  if (!target) {
    target = newestChat(mine);
    if (!target && yn) {
      if (mine.length === 1) target = mine[0];
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

const CLARIFY = (label: string) => `I'm not sure that was a yes, so "${label}" is still open. Say yes or no (or react 👍 / 👎).`;
const WHICH = "Which one do you mean? Reply to the question itself, or react to it.";

// APPROVAL_STYLE soft / conversational. Code decides only two things: an exact plain yes / no that unambiguously targets the one
// open approval (it is the single open one, or the reply quotes it), and the safety invariants below. Every other message is read by
// the judge against ALL open approvals (which one(s), yes / no / an allowed edit / something else); nothing is matched by words
// here and there is no length rule. Invariants kept in code: only this function (a message after the ask) or a reaction resolves an
// approval; an edit applies only through applyChanges (the allow-list); any judge failure or unusable answer approves nothing, is
// logged and is silent: the message goes on as a normal chat message.
async function answerSoft(text: string, onJudging: () => void, quote: { timestamp: number } | undefined, deps: SoftDeps, ctx: Ctx, mine: readonly Open[]): Promise<Answer> {
  const live = [...mine].sort((a, b) => a.ts - b.ts);
  const t = normalise(text);
  const found = quote && quote.timestamp !== 0 ? open.get(quote.timestamp) : undefined;
  const quoted = found?.scope === (ctx.scope ?? OWNER_SCOPE) ? found : undefined;
  const direct = quoted && !quoted.done ? quoted : live.length === 1 && !quote ? live[0] : undefined;
  if (direct && (YES.has(t) || NO.has(t))) {
    audit(direct.call.tool, "answer-fast", direct.source, { by: ctx.by, scope: direct.scope, reply: text, approved: YES.has(t), question: direct.shown });
    direct.resolve({ approved: YES.has(t) });
    return { outcome: YES.has(t) ? "approved" : "declined" };
  }
  const ids = new Map(live.map((o, i) => [`A${i + 1}`, o]));
  const views: OpenView[] = live.map((o, i) => ({
    id: `A${i + 1}`,
    background: o.background,
    ageMs: Date.now() - o.askedAt,
    question: o.shown,
    args: isModifiable(o.call.tool) ? o.call.input : undefined,
  }));
  const quotedId = quoted && [...ids].find(([, o]) => o === quoted)?.[0];
  onJudging();
  const started = Date.now();
  const j = await (deps.judge ?? judgeAnswer)(text, views, (deps.recent ?? (ctx.scope === undefined || ctx.scope === OWNER_SCOPE ? recentChat : () => []))(text), quote && quote.timestamp !== 0 || ctx.voice ? { id: quotedId, ended: !!quote && !quoted && closed.has(quote.timestamp), voice: ctx.voice } : undefined);
  const stillOpen = () => live.filter((o) => !o.done);
  const record = (what: string, o?: Open) => audit(o?.call.tool ?? "approval", `answer-${what}`, o?.source ?? "chat", { by: ctx.by, scope: o?.scope ?? ctx.scope, reply: text, question: o?.shown, verdict: j && `${j.target} ${j.outcome}`, reason: j?.reason, ms: Date.now() - started });
  // "Yes to both": each part is applied to its own approval; only the parts that are not a plain yes / no stay open, and the
  // reply asks about those alone. An unknown or ended approval is skipped, never guessed.
  const multi = (parts: readonly { target: string; outcome: "approve" | "decline" | "other" }[], reply?: string): Answer => {
    let approved = 0;
    let declined = 0;
    for (const p of parts) {
      const o = ids.get(p.target);
      if (!o || o.done || p.outcome === "other") continue;
      record(p.outcome === "approve" ? "approved" : "declined", o);
      o.resolve({ approved: p.outcome === "approve" });
      if (p.outcome === "approve") approved++;
      else declined++;
    }
    const left = stillOpen();
    const ask = left.length ? (reply ?? WHICH) : undefined;
    if (approved + declined === 0) return { outcome: "clarify", reply: ask };
    return { outcome: approved ? "approved" : "declined", ...(ask ? { reply: ask } : {}) };
  };
  if (!j) {
    // Not approved, and not silent for the agent: every open chat approval returns the owner's words as feedback, so the agent
    // decides itself whether to ask again, rephrase or drop the action (permissions.ts caps the re-asks). Background ones stay open.
    record("failed");
    const chat = live.filter((o) => !o.background && !o.done);
    for (const o of chat) o.resolve({ approved: false, feedback: text, failure: "the owner's reply could not be read as a yes or no" });
    return chat.length ? { outcome: "feedback" } : { outcome: "none" };
  }
  if (j.outcome === "unrelated") return record("unrelated"), { outcome: "none" };
  if (j.outcome === "multi") return multi(j.answers ?? [], j.reply);
  if (j.target === "unclear") {
    record("unclear");
    return { outcome: "clarify", reply: j.reply ?? WHICH };
  }
  const current = ids.get(j.target);
  if (!current || current.done) return { outcome: "none" }; // resolved or expired while the judge thought
  const call = current.call;
  if (j.outcome === "decline") {
    record("declined", current);
    current.resolve({ approved: false });
    return { outcome: "declined" };
  }
  if (j.outcome === "approve") {
    record("approved", current);
    current.resolve({ approved: true });
    return { outcome: "approved" };
  }
  if (j.outcome === "approve_modified") {
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
  record("clarify", current); // other: a condition, a delay, a question...; the approval stays open
  return { outcome: "clarify", reply: j.reply ?? CLARIFY(current.label) };
}

// Ask the owner. Resolves "not approved" on no, timeout, or an aborted turn. Several may be open at once.
// A chat approval waits APPROVAL_TIMEOUT_MINUTES, a background one BACKGROUND_APPROVAL_TIMEOUT_MINUTES.
export function request(
  send: (text: string) => Promise<number>, // returns the sent message's timestamp
  description: string,
  call: { tool: string; input: Record<string, unknown> },
  signal?: AbortSignal,
  opts: { background?: boolean; question?: string; scope?: string } = {},
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
    const entry: Open = { resolve: finish, label, call, background, ts: 0, done: false, shown, askedAt: Date.now(), source: opts.scope && opts.scope !== OWNER_SCOPE ? "group" : background ? "background" : "chat", warmed, scope: opts.scope ?? OWNER_SCOPE };
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
