import "./log.ts"; // first: timestamps, redaction and owner-only files for everything below
import { withQuoteContext, shouldThread } from "./quote.ts";
import { splitReaction } from "./reaction.ts";
import { ask, setDraftReader, AuthError, RateLimitError, setAutoApprovedNotice, compactChatIfNeeded, prepareChat, type Approve } from "./agent.ts";
import * as approvals from "./approvals.ts";
import { isBriefDue, maybeRunBrief } from "./brief.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { ensureNotesDir } from "./notes.ts";
import { recordPing } from "./pings.ts";
import { Mailbird } from "./mailbird.ts";
import { createProposer } from "./propose.ts";
import { createRadar } from "./radar.ts";
import { createOutbound } from "./outbound.ts";
import { settings } from "./settings.ts";
import { appendLine } from "./state.ts";
import { ensureSignalDaemon } from "./signal-daemon.ts";
import { SignalClient, type IncomingMessage } from "./signal.ts";
import { transcribe, voiceReady } from "./transcribe.ts";

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
  prepareChat(approve, say); // the chat prompt carries recent pings, so the warm process is stale now
};

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
signal.onMessage((m) => {
  if (!acceptOwner(m, config.ownerNumber)) return void console.log(`ignored a message from ${mask(m.from)}`);
  if (out.isOwnEcho(m)) return; // one of our own replies coming back
  (m.audio ? hear(m) : route(m)).catch((e) => console.error("route error:", e.message));
});

// A voice message: transcribe it here, log the transcript (logs/voice.jsonl, to inspect a mishearing), then
// handle it as chat. A spoken "yes" is never an approval (route skips the approval check for it).
async function hear(m: IncomingMessage) {
  const target = { author: m.from, timestamp: m.timestamp };
  void signal.react("👂", target);
  let heard = "";
  try {
    heard = await transcribe(m.audio!);
  } catch (e) {
    const gaps = voiceReady();
    console.error("voice: transcription failed:", (e as Error).message);
    void signal.react("⚠️", target);
    return void (await out.replyPlain(gaps.ok ? "I couldn't make out that voice message. Try again or type it." : `I can't transcribe voice messages yet: missing ${gaps.missing.join(", ")}.`));
  }
  console.log(`voice: transcribed (${heard.length} chars)`);
  if (!heard) {
    void signal.react("🤷", target);
    return void (await out.replyPlain("I couldn't hear any words in that voice message."));
  }
  appendLine("logs/voice.jsonl", JSON.stringify({ at: new Date().toISOString(), messageTimestamp: m.timestamp, text: heard })); // for inspection; the chat can read it
  await route({ ...m, text: heard, audio: undefined, voice: true });
}

// The owner's Mailbird connection for reply drafts: the handler's drafts are shown on Signal
// (propose.ts), and the approval of any send shows the draft read back from here (agent.ts).
setAutoApprovedNotice(say);
const proposer = createProposer({ mail: new Mailbird(), send: (t) => out.replyPlain(t) });
setDraftReader(proposer.read);

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
  const { outcome, changes } = m.voice ? { outcome: "none" as const, changes: undefined } : await approvals.answer(m.text, () => void signal.react("⏳", target));
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
    const { text, costUsd } = await ask(withQuoteContext(m.voice ? `[Voice message, transcribed automatically, so words may be misheard] ${m.text}` : m.text, m.quote), approve, say, m.text);
    console.log(`agent replied (${text.length} chars, $${costUsd.toFixed(4)})`);
    // The model may react instead of (or before) answering; its emoji then replaces the ✅ status.
    const { reaction, text: words } = splitReaction(text);
    if (words) await out.reply(words, { quote: shouldThread(!!m.quote, Date.now() - started) ? { text: m.text.slice(0, 200), author: m.from, timestamp: m.timestamp } : undefined });
    void signal.react(reaction ?? "✅", target);
    await compactChatIfNeeded(); // after the reply is out; the next message waits for it
  } catch (e) {
    console.error("agent error:", (e as Error).message);
    void signal.react("⚠️", target);
    await out.reply(
      e instanceof AuthError
        ? "My login expired. On the Mac, run `claude auth login`, then message me again."
        : e instanceof RateLimitError
          ? "I've hit my usage limit for now, so I can't think until it resets. Mail triage keeps running. Try me again a bit later."
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

const handler = createHandler({ approve, notify, propose: proposer.show });
handler.resume();

const radar = createRadar({ approve, notify: say, briefDue: isBriefDue }); // records its own pings

startHeartbeat({
  alert: notify,
  handle: handler.enqueue,
  briefDue: isBriefDue,
  onTick: () => {
    void maybeRunBrief({ approve, sendBrief: out.sendBriefSummary, notify });
    void radar();
  },
});
