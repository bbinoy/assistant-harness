import "./log.ts"; // first: timestamps, redaction and owner-only files for everything below
import { withQuoteContext, shouldThread } from "./quote.ts";
import { ask, AuthError, compactChatIfNeeded, prepareChat, type Approve } from "./agent.ts";
import * as approvals from "./approvals.ts";
import { isBriefDue, maybeRunBrief } from "./brief.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { ensureNotesDir } from "./notes.ts";
import { recordPing } from "./pings.ts";
import { createRadar } from "./radar.ts";
import { createOutbound } from "./outbound.ts";
import { settings } from "./settings.ts";
import { ensureSignalDaemon } from "./signal-daemon.ts";
import { SignalClient, type IncomingMessage } from "./signal.ts";

ensureNotesDir(); // first run: memory/notes/, where the chat agent keeps its notes

const signal = new SignalClient(settings.signalHost, settings.signalPort, config.ownerNumber);
const out = createOutbound(signal);
const approve: Approve = (description, call, abort) => approvals.request(out.replyPlain, description, call, abort);
// `say` is a plain message to the owner. `notify` is what the assistant sends on its own (mail
// alerts, handled mail, setup problems) and is also remembered, so the chat knows what a reply
// like "yes, do that" refers to (pings.ts). Memory announcements and chat answers use `say`.
const say = async (text: string) => void (await out.replyPlain(text));
const notify = async (text: string) => {
  recordPing(text);
  await say(text);
};

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
signal.onMessage((m) => {
  if (!acceptOwner(m, config.ownerNumber)) return void console.log(`ignored a message from ${mask(m.from)}`);
  if (out.isOwnEcho(m)) return; // one of our own replies coming back
  route(m).catch((e) => console.error("route error:", e.message));
});

// A 👍 / 👎 on the pending "Approve?" message answers it.
signal.onReaction((r) => {
  if (!acceptOwner(r, config.ownerNumber) || r.isRemove) return;
  const outcome = approvals.answerReaction(r.emoji, r.targetTimestamp);
  if (outcome !== "ignored") console.log(`approval ${outcome} (by reaction)`);
});

// Chat turns run one at a time, in order: two at once would share one session.
let queue: Promise<void> = Promise.resolve();

async function route(m: IncomingMessage) {
  // While an approval is pending, a message may be its answer. That must skip the queue:
  // the queue is blocked on the very turn that is waiting for it.
  const target = { author: m.from, timestamp: m.timestamp };
  const { outcome, changes } = await approvals.answer(m.text, () => void signal.react("⏳", target));
  if (outcome !== "none") {
    console.log(`approval ${outcome}${changes ? ` (${changes.map((c) => c.field).join(", ")})` : ""}`);
    void signal.react({ approved: "👍", modified: "👍", declined: "👎", feedback: "💬" }[outcome], target);
    // An edited call runs without a second look, so say exactly what changed.
    if (outcome === "modified" && changes) {
      await out.replyPlain(`Applied your change: ${changes.map((c) => `${c.field} → ${c.value}`).join(", ")}`);
    }
    return;
  }
  queue = queue.then(() => chat(m)).catch((e) => console.error("queue error:", e.message));
}

async function chat(m: IncomingMessage) {
  console.log(`owner message (${m.text.length} chars)`);
  const target = { author: m.from, timestamp: m.timestamp };
  // Status on the owner's message, each replacing the last: 👀 working, ✅ answered, ⚠️ failed.
  void signal.react("👀", target);
  try {
    if (m.quote) console.log(`owner is replying to an earlier message (${m.quote.text.length} chars)`);
    const started = Date.now();
    const { text, costUsd } = await ask(withQuoteContext(m.text, m.quote), approve, say);
    console.log(`agent replied (${text.length} chars, $${costUsd.toFixed(4)})`);
    await out.reply(text, { quote: shouldThread(!!m.quote, Date.now() - started) ? { text: m.text.slice(0, 200), author: m.from, timestamp: m.timestamp } : undefined });
    void signal.react("✅", target);
    await compactChatIfNeeded(); // after the reply is out; the next message waits for it
  } catch (e) {
    console.error("agent error:", (e as Error).message);
    void signal.react("⚠️", target);
    await out.reply(
      e instanceof AuthError
        ? "My login expired. On the Mac, run `claude auth login`, then message me again."
        : "Something broke on my end. Check the logs, I'm not telling you what it was.",
    );
  } finally {
    prepareChat(approve, say); // warm up the process for the next message
  }
}

await ensureSignalDaemon(config.ownerNumber, settings.signalHost, settings.signalPort);
await signal.connect();
console.log(`connected to signal-cli; accepting only ${mask(config.ownerNumber)}; auth: ${config.credential}`);

prepareChat(approve, say);
// A warm process is used only while fresh (agent.ts); keep one ready so a message after a
// quiet hour is still quick. Local work only, no model call.
setInterval(() => prepareChat(approve, say), 25 * 60_000).unref();

const handler = createHandler({ approve, notify });
handler.resume();

const radar = createRadar({ approve, notify: say, briefDue: isBriefDue }); // records its own pings

startHeartbeat({
  alert: notify,
  handle: handler.enqueue,
  briefDue: isBriefDue,
  onTick: () => {
    void maybeRunBrief({ approve, sendBrief: out.sendBrief, notify });
    void radar();
  },
});
