import { join } from "node:path";
import "./log.ts"; // first: timestamps, redaction and owner-only files for everything below
import { createPipeline, group, owner, type Pipeline } from "./conversation.ts";
import { ask, runBackgroundTurn, setDraftReader, setAutoApprovedNotice, compactChatIfNeeded, prepareChat, type Approve } from "./agent.ts";
import * as approvals from "./approvals.ts";
import { isBriefDue, maybeRunBrief } from "./brief.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createDreamer } from "./dream.ts";
import { createGroupBrain, groupName, ownerInGroup } from "./group.ts";
import { createGroupDreamer } from "./groupdream.ts";
import { groupDir, recordGroup } from "./groupstore.ts";
import { logTail } from "./gate.ts";
import { createWakeups } from "./wake.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { ensureNotesDir } from "./notes.ts";
import { compactIfNeeded, recordMessage, type Kind } from "./messages.ts";
import { summarizeWithHaiku } from "./summarize.ts";
import { Mailbird } from "./mailbird.ts";
import { createProposer } from "./propose.ts";
import { createRadar } from "./radar.ts";
import { createOutbound } from "./outbound.ts";
import { settings } from "./settings.ts";
import { openLog } from "./state.ts";
import { ensureSignalDaemon, SignalClient, synthesize, transcribe, ttsReady, voiceReady, type IncomingMessage } from "@ted-personal-assistant/signal";

ensureNotesDir(); // first run: memory/notes/, where the chat agent keeps its notes

const signal = new SignalClient(
  settings.signalHost,
  settings.signalPort,
  config.signalAccount,
  config.signalAccount !== config.ownerNumber ? { number: config.ownerNumber, aci: config.ownerAci } : undefined,
);
// What was said goes into that conversation's own log: the owner's chat, or the group's (made on first use).
function record(groupId: string | undefined, kind: Kind, ts: number, text: string) {
  if (groupId) return void (groupDir(groupId, groupName(groupId)), recordGroup(groupId, kind, ts, text));
  recordMessage(kind, ts, text);
  void compactIfNeeded(summarizeWithHaiku).catch((e) => console.error("messages: compaction failed:", e.message));
}
const out = createOutbound(signal, (kind, ts, text, groupId) => record(groupId, kind, ts, text));
const approve: Approve = (description, call, abort) => approvals.request((t) => out.replyPlain(t, "approval"), description, call, abort);
// `say` is a plain message to the owner. `notify` is what the assistant sends on its own (mail
// alerts, handled mail, setup problems) and is also remembered, so the chat knows what a reply
// like "yes, do that" refers to (messages.ts). Memory announcements and chat answers use `say`.
const say = async (text: string) => void (await out.replyPlain(text, "notice"));
const notify = async (text: string) => {
  await say(text);
  prepareChat(approve, say); // the chat prompt carries recent pings, so the warm process is stale now
};

// A voice message's words, from the local speech model; the transcript is logged (logs/voice.jsonl) to inspect a
// mishearing. Throws a sentence the user can be told if it cannot be made out.
async function transcript(m: IncomingMessage): Promise<string> {
  let heard = "";
  try {
    heard = await transcribe(join(settings.signalAttachmentsDir, m.audio!.id), settings.whisperModel);
  } catch (e) {
    const gaps = voiceReady(settings.whisperModel);
    console.error("voice: transcription failed:", (e as Error).message);
    throw new Error(gaps.ok ? "I couldn't make out that voice message. Try again or type it." : `I can't transcribe voice messages yet: missing ${gaps.missing.join(", ")}.`);
  }
  console.log(`voice: transcribed (${heard.length} chars)`);
  if (!heard) throw new Error("I couldn't hear any words in that voice message.");
  return heard;
}

// Group chats (src/group.ts): in any group the owner is a member of. Everything said or reacted there goes
// into that group's own history; the brain decides when the assistant speaks. No access to anything private.
const isOwnerAccount = (who: { number?: string; uuid?: string }) => who.number === config.ownerNumber || (!!config.ownerAci && who.uuid === config.ownerAci);
const fromOwner = (w: { from: string; fromUuid?: string }) => w.from === config.ownerNumber || (!!config.ownerAci && w.fromUuid === config.ownerAci);

// Both kinds of conversation run through one pipeline (src/conversation.ts). Spoken replies need the
// assistant's own chat (in Note to Self our own voice message would echo back as if the owner had sent
// it) and the local speech setup.
const pipeline: Pipeline = createPipeline({
  signal,
  out,
  record,
  account: config.signalAccount,
  runOwner: (prompt, ownerMessage) => ask(prompt, approve, say, ownerMessage),
  transcript,
  speech: {
    ready: () => settings.voiceReplies && signal.separateAccount && ttsReady(settings.ttsDir).ok,
    synth: (words) => synthesize(words, { dir: settings.ttsDir, voice: settings.ttsVoice, speed: settings.ttsSpeed }),
  },
  approvals,
  vouch: (groupId) => ownerInGroup(groupId, () => signal.groups(), isOwnerAccount),
  isOwner: fromOwner,
  admitGroup: (_conv, m) => groupBrain(m),
  compact: (conv) => compactChatIfNeeded(conv.sessionFile, conv.source), // every conversation, after the reply is out; the next message waits for it
  // Warm process: one, for the owner's chat. Groups have none (bursty, many; a cold start per group turn is the price).
  afterTurn: (conv) => void (conv.kind === "owner" && prepareChat(approve, say)),
});
const groupBrain = createGroupBrain({ pipeline, recent: (groupId) => logTail(group(groupId)) });

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
signal.onMessage((m) => {
  if (m.group) return void pipeline.handleIncoming(group(m.group.id), { type: "message", m }).catch((e) => console.error("group error:", e.message));
  if (!acceptOwner(m, config.ownerNumber)) return void console.log(`ignored a message from ${mask(m.from)}`);
  if (out.isOwnEcho(m)) return; // one of our own replies coming back
  pipeline.handleIncoming(owner(), { type: "message", m }).catch((e) => console.error("route error:", e.message));
});

// The owner's Mailbird connection for reply drafts: the handler's drafts are shown on Signal
// (propose.ts), and the approval of any send shows the draft read back from here (agent.ts).
setAutoApprovedNotice(say);
const proposer = createProposer({ mail: new Mailbird(), send: (t) => out.replyPlain(t, "draft") });
setDraftReader(proposer.read);

// A 👍 / 👎 on the pending "Approve?" message answers it (the pipeline checks); any other reaction of the
// owner is feedback. Our own status icons come back as reactions and are dropped.
signal.onReaction((r) => {
  if (r.isRemove || signal.isOwnReaction(r)) return;
  if (r.group) return void pipeline.handleIncoming(group(r.group.id), { type: "reaction", r }).catch((e) => console.error("group error:", e.message));
  if (!acceptOwner(r, config.ownerNumber)) return;
  pipeline.handleIncoming(owner(), { type: "reaction", r }).catch((e) => console.error("reaction error:", e.message));
});

await ensureSignalDaemon(config.signalAccount, settings.signalHost, settings.signalPort, openLog("logs/signal-daemon.log"));
await signal.connect();
console.log(`connected to signal-cli (${signal.separateAccount ? "own account" : "Note to Self"}); accepting only ${mask(config.ownerNumber)}; auth: ${config.credential}`);

prepareChat(approve, say);
// A warm process is used only while fresh (agent.ts); keep one ready so a message after a
// quiet hour is still quick. Local work only, no model call.
setInterval(() => prepareChat(approve, say), 25 * 60_000).unref();

const handler = createHandler({ approve, notify, propose: proposer.show });
handler.resume();

const dreamer = createDreamer();
const groupDreamer = createGroupDreamer();
// The clock half of the gate: every tick, each conversation whose next look has come may be woken (wake.ts).
const wakeups = createWakeups({
  pipeline,
  vouch: (groupId) => ownerInGroup(groupId, () => signal.groups(), isOwnerAccount),
  runOwner: (prompt) => runBackgroundTurn(prompt, approve),
});
const radar = createRadar({ approve, notify: say, briefDue: isBriefDue });

startHeartbeat({
  alert: notify,
  handle: handler.enqueue,
  briefDue: isBriefDue,
  onTick: () => {
    // The dream first (it tidies the notes the brief then reads), but never in the brief's way:
    // it runs at most once a day, only when you said something new, and a failure just moves on.
    const dreaming = isBriefDue() ? dreamer.run().then(() => groupDreamer.run()).catch(() => {}) : Promise.resolve();
    void dreaming.then(() => maybeRunBrief({ approve, sendBrief: out.sendBriefSummary, notify }));
    void radar();
    void wakeups.tick().catch((e) => console.error("wake: tick failed:", e.message));
  },
});
