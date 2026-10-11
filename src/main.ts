import "./log.ts";
import { ask, AuthError } from "./agent.ts";
import * as approvals from "./approvals.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { ensureSignalDaemon } from "./signal-daemon.ts";
import { isBriefDue, maybeRunBrief } from "./brief.ts";
import { createOutbound } from "./outbound.ts";
import { SignalClient, type IncomingMessage } from "./signal.ts";

const signal = new SignalClient(config.signalHost, config.signalPort, config.ownerNumber);
const { reply, replyPlain, sendBrief, isOwnEcho } = createOutbound(signal);

async function handle(m: IncomingMessage) {
  // 1. Allowlist: only the owner, only via Note to Self. Everything else is dropped.
  if (!acceptOwner(m, config.ownerNumber)) {
    console.log(`dropped message from ${mask(m.from)}`);
    return;
  }
  // 2. Ignore our own replies.
  if (isOwnEcho(m)) return;

  console.log(`owner message (${m.text.length} chars)`);
  const target = { author: m.from, timestamp: m.timestamp };
  // 👀 = received and working, ✅ = answered, ⚠️ = failed. Each replaces the last.
  // Not awaited: the model call should not wait on a reaction round trip.
  void signal.react("👀", target);
  try {
    const { text, costUsd } = await ask(m.text, (description, call, abort) =>
      approvals.request(replyPlain, description, call, abort),
    );
    console.log(`agent replied (${text.length} chars, $${costUsd.toFixed(4)})`);
    await reply(text);
    void signal.react("✅", target);
  } catch (e) {
    console.error("agent error:", (e as Error).message);
    void signal.react("⚠️", target);
    await reply(
      e instanceof AuthError
        ? "My login expired. On the Mac, run `claude auth login`, then message me again."
        : "Something broke on my end. Check the logs, I'm not telling you what it was.",
    );
  }
}

// Serial queue: messages are handled one at a time, in order. Without this, two
// quick messages would run two turns against the same session at once.
let queue: Promise<void> = Promise.resolve();
signal.onMessage((m) => {
  route(m).catch((e) => console.error("route error:", e.message));
});

// Reactions: only the owner's, only on the pending approval message.
signal.onReaction((r) => {
  if (r.from !== config.ownerNumber || r.isRemove) return;
  const outcome = approvals.answerReaction(r.emoji, r.targetTimestamp);
  if (outcome !== "ignored") console.log(`approval ${outcome} (by reaction)`);
});

async function route(m: IncomingMessage) {
  // While an approval is pending, an owner message may be the answer. It must
  // skip the queue: the queue is blocked on the very turn waiting for it.
  if (acceptOwner(m, config.ownerNumber) && !isOwnEcho(m)) {
    const target = { author: m.from, timestamp: m.timestamp };
    const { outcome, changes } = await approvals.answer(m.text, () => void signal.react("⏳", target));
    if (outcome !== "none") {
      console.log(`approval ${outcome}${changes ? ` (${changes.map((c) => c.field).join(", ")})` : ""}`);
      const emoji = { approved: "👍", modified: "👍", declined: "👎", feedback: "💬" }[outcome];
      void signal.react(emoji, target);
      // Show exactly what was changed, since the edited call runs without a second look.
      if (outcome === "modified" && changes) {
        await replyPlain(`Applied your change: ${changes.map((c) => `${c.field} → ${c.value}`).join(", ")}`);
      }
      return;
    }
  }
  queue = queue.then(() => handle(m)).catch((e) => console.error("queue error:", e.message));
}

await ensureSignalDaemon(config.ownerNumber, config.signalHost, config.signalPort);
await signal.connect();
console.log(`connected to signal-cli; accepting only ${mask(config.ownerNumber)}; auth: ${config.credential}`);
const approve = (description: string, call: { tool: string; input: Record<string, unknown> }, abort: AbortSignal) =>
  approvals.request(replyPlain, description, call, abort);
const notify = async (text: string) => void (await replyPlain(text));

const handler = createHandler({ approve, notify });
handler.resume(); // pick up anything queued before a restart

startHeartbeat({
  alert: notify,
  handle: handler.enqueue,
  briefDue: () => isBriefDue(),
  onTick: (mb) => maybeRunBrief({ mb, approve, sendBrief, notify }),
});
