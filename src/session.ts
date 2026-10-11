// The chat conversation (Note to Self) persists across restarts, but not forever:
//   - after a long idle gap it starts fresh (continuity comes from memory/facts.md and
//     memory/last-brief.md, which are in the chat system prompt), and
//   - after a turn whose context grew large it is compacted early, because the SDK only
//     auto-compacts near the context limit and every turn re-sends the whole history.
// The decision is a pure function so the boundaries are unit-tested.

export interface ChatSession {
  sessionId?: string;
  costUsd: number; // total_cost_usd is cumulative across a resumed session, so we keep the running total
  lastTurnAt?: string; // ISO time the last chat turn finished
  lastContextTokens?: number; // context size of that turn (input + cached input of its last model call)
  compactFailedAt?: string; // ISO time of the last failed compaction: back off instead of retrying every turn
}

const COMPACT_BACKOFF_MS = 3600_000;

export type SessionPlan = "fresh" | "resume" | "resume then compact";

// Missing fields (a session.json from before these rules) never trigger anything: resume.
export function planSession(s: ChatSession, now: Date, opts: { idleResetHours: number; compactTokens: number }): SessionPlan {
  if (!s.sessionId) return "fresh";
  const last = s.lastTurnAt ? Date.parse(s.lastTurnAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last > opts.idleResetHours * 3600_000) return "fresh";
  if (typeof s.lastContextTokens === "number" && s.lastContextTokens > opts.compactTokens) {
    const failed = s.compactFailedAt ? Date.parse(s.compactFailedAt) : NaN;
    if (Number.isFinite(failed) && now.getTime() - failed < COMPACT_BACKOFF_MS) return "resume"; // it just failed; do not pay for another try yet
    return "resume then compact";
  }
  return "resume";
}
