import "./log.ts"; // first: timestamps, redaction and owner-only files for everything below
import { createPipeline, group, owner, type Pipeline } from "./conversation.ts";
import { ask, runProfile, prepareChat } from "./agent.ts";
import { compactChatIfNeeded, compactDue } from "./chatsession.ts";
import { gmailReaders } from "./gmail.ts";
import { setDraftReader, setGmailReaders, setGroupApprover, type Approve } from "./permissions.ts";
import * as approvals from "./approvals.ts";
import { makeApprove } from "./approvalask.ts";
import { config, mask } from "./config.ts";
import { acceptOwner } from "./guards.ts";
import { createDreamer } from "./dream.ts";
import { createGroupBrain, groupName, ownerInGroup } from "./group.ts";
import { createGroupDreamer } from "./groupdream.ts";
import { groupDir, recordGroup } from "./groupstore.ts";
import { logTail } from "./gate.ts";
import { createWakeups } from "./wake.ts";
import { createHandler } from "./handler.ts";
import { startHeartbeat, startJobs } from "./heartbeat.ts";
import { writeNotice } from "./notice.ts";
import { ensureNotesDir } from "./notes.ts";
import { compactIfNeeded, recordMessage, type Extra, type Kind } from "./messages.ts";
import { summarizeWithHaiku } from "./summarize.ts";
import { Mailbird } from "./mailbird.ts";
import { createProposer } from "./propose.ts";
import { preparePicture } from "./image.ts";
import { prepareDocument } from "./document.ts";
import { createOutbound } from "./outbound.ts";
import { settings } from "./settings.ts";
import { unsupportedForVoice } from "./lang.ts";
import { openLog } from "./state.ts";
import { attachmentPath, ensureSignalDaemon, SignalClient, type IncomingMessage } from "@ted-personal-assistant/signal";
import { providerReady, stopQwen, synthesizeWith, warmQwen } from "@ted-personal-assistant/signal/tts";
import { Limiter } from "./limiter.ts";
import { transcribe, voiceReady } from "@ted-personal-assistant/signal/voice";

ensureNotesDir(); // first run: memory/notes/, where the chat agent keeps its notes

const signal = new SignalClient({
  host: settings.signalHost,
  port: settings.signalPort,
  account: config.signalAccount,
  peer: config.signalAccount !== config.ownerNumber ? { number: config.ownerNumber, aci: config.ownerAci } : undefined,
  logger: console, // the app's console is the timestamped, redacting one from log.ts
});
// What was said goes into that conversation's own log: the owner's chat, or the group's (made on first use).
function record(groupId: string | undefined, kind: Kind, ts: number, text: string, extra?: Extra) {
  if (groupId) return void (groupDir(groupId, groupName(groupId)), recordGroup(groupId, kind, ts, text, extra));
  recordMessage(kind, ts, text, new Date(), undefined, extra);
  void compactIfNeeded(summarizeWithHaiku).catch((e) => console.error("messages: compaction failed:", e.message));
}
const out = createOutbound(signal, (kind, ts, text, groupId) => record(groupId, kind, ts, text));
const approve: Approve = makeApprove((t) => out.replyPlain(t, "approval"));
// Unattended runs (wake-ups, the brief, the radar, the mail handler) ask the same way, but only an explicit yes / no or a reply
// to the question answers it: whatever else the owner types meanwhile is a chat message (approvals.ts).
// A group asks in the group itself; any member may answer there (approvals.ts scopes every question to its conversation).
setGroupApprover((groupId) => makeApprove((t) => out.reply(t, { plain: true, kind: "approval", groupId }), { scope: groupId }));
const approveBackground: Approve = makeApprove((t) => out.replyPlain(t, "approval"), { background: true });
// `say` is a plain message to the owner. `notify` is what the assistant sends on its own (mail
// alerts, handled mail, setup problems) and is also remembered, so the chat knows what a reply
// like "yes, do that" refers to (messages.ts). Memory announcements and chat answers use `say`.
const say = async (text: string) => void (await out.replyPlain(text, "notice"));
const warmChat = () => prepareChat(approve, say);
const notify = async (text: string) => {
  await say(text);
  prepareChat(approve, say, { refresh: true }); // the chat prompt carries recent pings, so the warm process is stale now (a renewal, not activity)
};

// Every voice message is transcribed (in a group it may be meant for the assistant), but only a few at a time: a flood waits in line
// instead of starting that many whisper processes. One line for the owner's chat and every group.
const transcribing = new Limiter(() => settings.transcribeConcurrency);

// A voice message's words, from the local speech model; the transcript is logged (logs/voice.jsonl) to inspect a
// mishearing. Throws a sentence the user can be told if it cannot be made out.
async function transcript(m: IncomingMessage): Promise<string> {
  let heard = "";
  try {
    heard = await transcribing.run(() => transcribe(attachmentPath(m.audio!, settings.signalAttachmentsDir), settings.whisperModel));
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
const isOwnerId = (number?: string, uuid?: string) => number === config.ownerNumber || (!!config.ownerAci && uuid === config.ownerAci);
const isOwnerAccount = (who: { number?: string; uuid?: string }) => isOwnerId(who.number, who.uuid);
const fromOwner = (w: { from: string; fromUuid?: string }) => isOwnerId(w.from, w.fromUuid);
const vouch = (groupId: string) => ownerInGroup(groupId, () => signal.groups(), isOwnerAccount); // is the owner in this group?

// Both kinds of conversation run through one pipeline (src/conversation.ts). Spoken replies need the
// assistant's own chat (in Note to Self our own voice message would echo back as if the owner had sent
// it) and the local speech setup.
const pipeline: Pipeline = createPipeline({
  signal,
  out,
  record,
  account: config.signalAccount,
  runOwner: (prompt, ownerMessage, pictures, hooks, documents) => ask(prompt, approve, say, ownerMessage, pictures, hooks, documents),
  picture: (m) => preparePicture(attachmentPath(m.image!, settings.signalAttachmentsDir)), // a plain file name inside signal-cli's folder
  document: async (m) => prepareDocument(attachmentPath(m.file!, settings.signalAttachmentsDir), m.file!.name), // the same: only the id, joined to signal-cli's folder
  transcript,
  speech: {
    ready: () => settings.voiceReplies && signal.separateAccount && providerReady(settings.tts).ok,
    synth: (words) => synthesizeWith(words, settings.tts, console),
    foreign: (words) => unsupportedForVoice(words, settings.ttsLanguages),
  },
  approvals,
  vouch,
  isOwner: fromOwner,
  admitGroup: (_conv, m) => groupBrain(m),
  compact: (conv, mode) => compactChatIfNeeded(conv.sessionFile, conv.source, conv.notesDir, mode), // every conversation, after the reply is out and only when it grew far past the limit (urgent); the next message waits for it
  // The owner's chat is kept warm after each turn; the group that spoke last has its own warm process (group.ts).
  afterTurn: (conv) => void (conv.kind === "owner" && warmChat()),
});
const groupBrain = createGroupBrain({ pipeline, recent: (groupId) => logTail(group(groupId)) });

// The linked device sees ALL of the owner's Signal traffic. Only their own Note to Self is
// ever acted on; everything else is dropped here, before it can reach anything else.
// A group's event goes to the group; anything else must be the owner's own chat (the caller has checked).
const route = (w: { group?: { id: string } }, ev: Parameters<Pipeline["handleIncoming"]>[1]) =>
  void pipeline.handleIncoming(w.group ? group(w.group.id) : owner(), ev).catch((e) => console.error(`${ev.type} error:`, e.message));
signal.onMessage((m) => {
  if (!m.group) {
    if (!acceptOwner(m, config.ownerNumber)) return void console.log(`ignored a message from ${mask(m.from)}`);
    if (!m.edited && out.isOwnEcho(m)) return; // one of our own replies coming back (an edit is the owner's, never an echo)
  }
  route(m, { type: "message", m });
});

// A message deleted for everyone: the same door as a message.
signal.onDelete((d) => {
  if (d.group || acceptOwner(d, config.ownerNumber)) route(d, { type: "deletion", d });
});

// The owner's Mailbird connection for reply drafts: the handler's drafts are shown on Signal
// (propose.ts), and the approval of any send shows the draft read back from here (agent.ts).
// MAIL_PROVIDER=none: no mail client is made at all, so there is no proposer and no mail handler either.
const proposer = settings.mailProvider === "mailbird" ? createProposer({ mail: new Mailbird(), send: (t) => out.replyPlain(t, "draft") }) : undefined;
if (proposer) setDraftReader(proposer.read);
// Gmail: the approval of a send reads the draft (or the message being replied to) back through the connector (gmail.ts).
if (settings.mailProvider === "gmail") setGmailReaders(gmailReaders());

// A 👍 / 👎 on the pending approval message answers it (the pipeline checks); any other reaction of the
// owner is feedback. Our own status icons come back as reactions and are dropped.
signal.onReaction((r) => {
  if (r.isRemove || signal.isOwnReaction(r)) return;
  if (r.group || acceptOwner(r, config.ownerNumber)) route(r, { type: "reaction", r });
});

// Policy of this app, not of the signal package: if Signal goes away we exit, and launchd restarts the whole agent
// cleanly instead of leaving a process with no Signal connection. A signal we are asked to stop on takes the daemon down too.
const daemon = await ensureSignalDaemon({ account: config.signalAccount, host: settings.signalHost, port: settings.signalPort, logFd: openLog("logs/signal-daemon.log"), logger: console });
void daemon.exited.then(({ code, signal: sig }) => {
  console.error(`signal-cli exited (code=${code} signal=${sig}); exiting so launchd restarts us`);
  process.exit(1);
});
process.once("exit", () => daemon.stop());
for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => (daemon.stop(), stopQwen(), process.exit(0)));
signal.onClose(({ error }) => {
  console.error(`signal socket closed${error ? ` (${error.message})` : ""}; exiting so launchd restarts us`);
  process.exit(1);
});
await signal.connect();
console.log(`connected to signal-cli (${signal.separateAccount ? "own account" : "Note to Self"}); accepting only ${mask(config.ownerNumber)}; auth: ${config.credential}`);

warmChat();
// The cloned voice takes a few seconds to load: have it ready for the first spoken reply (it is stopped again after WARM_IDLE_MINUTES idle, and the next reply restarts it).
if (settings.tts.provider === "qwen" && settings.warm && settings.voiceReplies && providerReady(settings.tts).ok) void warmQwen(settings.tts.qwen).then((err) => console.log(err ? `Qwen voice not warmed up (Kokoro stands in): ${err}` : "Qwen voice server ready"));
// A warm process is used only while fresh (agent.ts); keep one ready so a message after a
// quiet hour is still quick. Local work only, no model call.
setInterval(() => prepareChat(approve, say, { refresh: true }), settings.warmRefreshMinutes * 60_000).unref();

const handler = proposer ? createHandler({ approve: approveBackground, notify, write: writeNotice, propose: proposer.show }) : undefined;
handler?.resume();

const dreamer = createDreamer();
const groupDreamer = createGroupDreamer();
// The dream tidies the notes the brief then reads; it runs at most once a day, only when you said something new, and a
// failure just moves on.
const dream = () => dreamer.run().then(() => groupDreamer.run()).catch(() => {});
// The clock half of the gate: every tick, each conversation whose next look has come may be woken (wake.ts). The owner's
// gate also decides when the brief and the radar run, with a deterministic backstop for the brief.
const wakeups = createWakeups({
  pipeline,
  separateAccount: signal.separateAccount,
  vouch,
  runProfile: (profile, prompt, extra) => runProfile(profile, prompt, approveBackground, extra),
  presets: { sendBrief: out.sendBriefSummary, notify: say, beforeBrief: dream },
  compact: { due: (conv) => compactDue(conv.sessionFile), run: (conv) => compactChatIfNeeded(conv.sessionFile, conv.source, conv.notesDir, "quiet") },
});

// Independent jobs: each starts on every tick in its own try/catch and none waits for another (startJobs, heartbeat.ts; the
// dream runs inside the brief preset, before the brief).
startHeartbeat({
  alert: notify,
  write: writeNotice,
  handle: (items) => handler?.enqueue(items),
  briefDue: () => wakeups.briefPending(),
  onTick: () => {
    startJobs({
      wake: () => wakeups.tick(),
    });
  },
});
