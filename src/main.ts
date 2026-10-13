import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import "./log.ts"; // first: timestamps, redaction and owner-only files for everything below
import { withQuoteContext, shouldThread } from "./quote.ts";
import { reactionPrompt, splitReaction } from "./reaction.ts";
import { splitVoice, VOICE_INVITE } from "./voicereply.ts";
import { ask, setDraftReader, AuthError, RateLimitError, setAutoApprovedNotice, compactChatIfNeeded, prepareChat, type Approve } from "./agent.ts";
import * as approvals from "./approvals.ts";
import { isBriefDue, maybeRunBrief } from "./brief.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createDreamer } from "./dream.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { ensureNotesDir } from "./notes.ts";
import { compactIfNeeded, findMessage, recordMessage } from "./messages.ts";
import { summarizeWithHaiku } from "./summarize.ts";
import { Mailbird } from "./mailbird.ts";
import { createProposer } from "./propose.ts";
import { createRadar } from "./radar.ts";
import { createOutbound } from "./outbound.ts";
import { settings } from "./settings.ts";
import { openLog } from "./state.ts";
import { ensureSignalDaemon, MAX_SPOKEN_CHARS, SignalClient, synthesize, transcribe, ttsReady, voiceReady, type IncomingMessage, type IncomingReaction } from "@ted-personal-assistant/signal";

ensureNotesDir(); // first run: memory/notes/, where the chat agent keeps its notes

const signal = new SignalClient(
  settings.signalHost,
  settings.signalPort,
  config.signalAccount,
  config.signalAccount !== config.ownerNumber ? { number: config.ownerNumber, aci: config.ownerAci } : undefined,
);
const out = createOutbound(signal, (kind, ts, text) => {
  recordMessage(kind, ts, text);
  void compactIfNeeded(summarizeWithHaiku).catch((e) => console.error("messages: compaction failed:", e.message));
});
const approve: Approve = (description, call, abort) => approvals.request((t) => out.replyPlain(t, "approval"), description, call, abort);
// `say` is a plain message to the owner. `notify` is what the assistant sends on its own (mail
// alerts, handled mail, setup problems) and is also remembered, so the chat knows what a reply
// like "yes, do that" refers to (messages.ts). Memory announcements and chat answers use `say`.
const say = async (text: string) => void (await out.replyPlain(text, "notice"));
const notify = async (text: string) => {
  await say(text);
  prepareChat(approve, say); // the chat prompt carries recent pings, so the warm process is stale now
};

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
signal.onMessage((m) => {
  if (!acceptOwner(m, config.ownerNumber)) return void console.log(`ignored a message from ${mask(m.from)}`);
  if (out.isOwnEcho(m)) return; // one of our own replies coming back
  void signal.markRead(m.timestamp); // the owner sees it was read, as soon as we have it
  (m.audio ? hear(m) : route(m)).catch((e) => console.error("route error:", e.message));
});

// A voice message: transcribe it here, log the transcript (logs/voice.jsonl, to inspect a mishearing), then
// handle it as chat. A spoken "yes" is never an approval (route skips the approval check for it).
async function hear(m: IncomingMessage) {
  const target = { author: m.from, timestamp: m.timestamp };
  status("👂", target);
  let heard = "";
  try {
    heard = await transcribe(join(settings.signalAttachmentsDir, m.audio!.id), settings.whisperModel);
  } catch (e) {
    const gaps = voiceReady(settings.whisperModel);
    console.error("voice: transcription failed:", (e as Error).message);
    status("⚠️", target);
    return void (await out.replyPlain(gaps.ok ? "I couldn't make out that voice message. Try again or type it." : `I can't transcribe voice messages yet: missing ${gaps.missing.join(", ")}.`));
  }
  console.log(`voice: transcribed (${heard.length} chars)`);
  if (!heard) {
    status("🤷", target);
    return void (await out.replyPlain("I couldn't hear any words in that voice message."));
  }
  await route({ ...m, text: heard, audio: undefined, voice: true });
}

// The owner's Mailbird connection for reply drafts: the handler's drafts are shown on Signal
// (propose.ts), and the approval of any send shows the draft read back from here (agent.ts).
setAutoApprovedNotice(say);
const proposer = createProposer({ mail: new Mailbird(), send: (t) => out.replyPlain(t, "draft") });
setDraftReader(proposer.read);

// A 👍 / 👎 on the pending "Approve?" message answers it.
signal.onReaction((r) => {
  if (!acceptOwner(r, config.ownerNumber) || r.isRemove) return;
  if (signal.isOwnReaction(r)) return; // our own status icons come back as reactions
  const outcome = approvals.answerReaction(r.emoji, r.targetTimestamp);
  if (outcome !== "ignored") return void console.log(`approval ${outcome} (by reaction)`);
  queue = queue.then(() => reacted(r)).catch((e) => console.error("reaction error:", e.message));
});

// Working / done / failed icons on the owner's message. Only in Note to Self, where Signal shows no
// "typing…"; in the assistant's own chat the typing indicator says it, and only the model's own
// reactions (and error replies) remain.
function status(emoji: string, target: { author: string; timestamp: number }) {
  if (!signal.separateAccount) void signal.react(emoji, target);
}

// Chat turns run one at a time, in order: two at once would share one session.
let queue: Promise<void> = Promise.resolve();

async function route(m: IncomingMessage) {
  recordMessage("owner", m.timestamp, m.voice ? `🎙️ ${m.text}` : m.text); // what the owner said: searchable, and what the dream learns from
  // While an approval is pending, a message may be its answer. That must skip the queue:
  // the queue is blocked on the very turn that is waiting for it.
  const target = { author: m.from, timestamp: m.timestamp };
  const { outcome, changes } = m.voice ? { outcome: "none" as const, changes: undefined } : await approvals.answer(m.text, () => status("⏳", target));
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

// Any other reaction is feedback on a message. The chat agent is told which message it was on
// (looked up by timestamp in the message log) and decides what, if anything, it means.
async function reacted(r: IncomingReaction) {
  console.log(`owner reacted ${r.emoji}`);
  try {
    const target = findMessage(r.targetTimestamp);
    recordMessage("reaction", Date.now(), `${r.emoji} on: ${(target?.text ?? "an older message").slice(0, 200)}`);
    const prompt = reactionPrompt(r.emoji, target);
    const { text } = await ask(prompt, approve, say, prompt);
    const { reaction, text: words } = splitReaction(text);
    if (reaction) void signal.react(reaction, { author: r.targetAuthor ?? config.signalAccount, timestamp: r.targetTimestamp });
    if (words) await out.reply(words, { kind: "chat" });
  } catch (e) {
    console.error("agent error (reaction):", (e as Error).message); // a reaction needs no apology
  } finally {
    prepareChat(approve, say);
  }
}

// Spoken replies need the assistant's own chat (in Note to Self our own voice message would echo back
// as if the owner had sent it) and the local speech setup.
const canSpeak = () => settings.voiceReplies && signal.separateAccount && ttsReady(settings.ttsDir).ok;

// Speaks and sends. False on any failure: the caller then sends the words as text.
async function speakReply(words: string): Promise<boolean> {
  let file: string | undefined;
  try {
    file = await synthesize(words, { dir: settings.ttsDir, voice: settings.ttsVoice, speed: settings.ttsSpeed });
    await out.sendVoice(file, words);
    return true;
  } catch (e) {
    console.error("voice reply failed, sending text:", (e as Error).message);
    return false;
  } finally {
    if (file) rmSync(dirname(file), { recursive: true, force: true });
  }
}

async function chat(m: IncomingMessage) {
  console.log(`owner message (${m.text.length} chars)`);
  const target = { author: m.from, timestamp: m.timestamp };
  // Status on the owner's message, each replacing the last: 👀 working, ✅ answered, ⚠️ failed.
  status("👀", target);
  // In the assistant's own chat Signal shows "typing…" (not in Note to Self); refreshed until the reply is out.
  void signal.typing();
  const typing = signal.separateAccount ? setInterval(() => void signal.typing(), 8000) : undefined;
  try {
    if (m.quote) console.log(`owner is replying to an earlier message (${m.quote.text.length} chars)`);
    const started = Date.now();
    const speak = canSpeak();
    const { text: replied, costUsd } = await ask(withQuoteContext(m.voice ? `[Voice message, transcribed automatically, so words may be misheard${speak ? `; ${VOICE_INVITE}` : ""}] ${m.text}` : m.text, m.quote), approve, say, m.text);
    console.log(`agent replied (${replied.length} chars, $${costUsd.toFixed(4)})`);
    // The model may answer by voice (only to a voice message, and only if speech is set up), ...
    const chosen = splitVoice(replied);
    let spoken = false;
    if (chosen.voice && speak && chosen.voice.length <= MAX_SPOKEN_CHARS) spoken = await speakReply(chosen.voice);
    const text = spoken ? "" : chosen.text;
    // ... or react instead of (or before) answering; its emoji then replaces the ✅ status.
    const { reaction, text: words } = splitReaction(text);
    if (words) await out.reply(words, { kind: "chat", quote: shouldThread(!!m.quote, Date.now() - started) ? { text: m.text.slice(0, 200), author: m.from, timestamp: m.timestamp } : undefined });
    if (reaction) void signal.react(reaction, target); // the model's own choice, in either mode
    else status("✅", target);
    await compactChatIfNeeded(); // after the reply is out; the next message waits for it
  } catch (e) {
    console.error("agent error:", (e as Error).message);
    status("⚠️", target);
    await out.reply(
      e instanceof AuthError
        ? "My login expired. On the Mac, run `claude auth login`, then message me again."
        : e instanceof RateLimitError
          ? "I've hit my usage limit for now, so I can't think until it resets. Mail triage keeps running. Try me again a bit later."
          : "Something broke on my end. Check the logs, I'm not telling you what it was.",
    );
  } finally {
    clearInterval(typing);
    void signal.typing(true);
    prepareChat(approve, say); // warm up the process for the next message
  }
}

await ensureSignalDaemon(config.signalAccount, settings.signalHost, settings.signalPort, openLog("logs/signal-daemon.log"));
await signal.connect();
console.log(`connected to signal-cli (${signal.separateAccount ? "own account" : "Note to Self"}); accepting only ${mask(config.ownerNumber)}; auth: ${config.credential}`);

prepareChat(approve, say);
// A warm process is used only while fresh (agent.ts); keep one ready so a message after a
// quiet hour is still quick. Local work only, no model call.
setInterval(() => prepareChat(approve, say), 25 * 60_000).unref();

const handler = createHandler({ approve, notify, propose: proposer.show });
handler.resume();

const dreamer = createDreamer({ notify });
const radar = createRadar({ approve, notify: say, briefDue: isBriefDue });

startHeartbeat({
  alert: notify,
  handle: handler.enqueue,
  briefDue: isBriefDue,
  onTick: () => {
    // The dream first (it tidies the notes the brief then reads), but never in the brief's way:
    // it runs at most once a day, only when you said something new, and a failure just moves on.
    const dreaming = isBriefDue() ? dreamer.run().catch(() => {}) : Promise.resolve();
    void dreaming.then(() => maybeRunBrief({ approve, sendBrief: out.sendBriefSummary, notify }));
    void radar();
  },
});
