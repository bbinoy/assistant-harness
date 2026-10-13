# @ted-personal-assistant/signal

A small client for [signal-cli](https://github.com/AsamK/signal-cli)'s JSON-RPC daemon, for building a personal assistant or bot on Signal. No dependencies, Node 24+ (it runs TypeScript directly). Extracted from the Ted personal assistant; everything in this folder works on its own.

## Two ways to talk to someone

| Mode | The bot is | The person sees | Constructor |
|---|---|---|---|
| **Note to Self** (default) | a linked device of *their* Signal account | a chat with themselves | `new SignalClient(host, port, theirNumber)` |
| **Own account** | a separate Signal account with its own name | a contact (and it can join groups) | `new SignalClient(host, port, botAccount, { number: theirNumber })` |

Own-account mode needs a Signal account for the bot (a spare number, or Signal Login without one), created with signal-cli. The app's [SIGNAL-ACCOUNT.md](../../docs/SIGNAL-ACCOUNT.md) shows how.

## Use

```ts
import { SignalClient, ensureSignalDaemon } from "@ted-personal-assistant/signal";

const me = process.env.SIGNAL_NUMBER!;     // you, international format
const bot = process.env.SIGNAL_ACCOUNT;    // optional: the bot's own account (a number or an account id)

await ensureSignalDaemon(bot ?? me, "127.0.0.1", 7583);   // starts and supervises `signal-cli daemon`
const signal = new SignalClient("127.0.0.1", 7583, bot ?? me, bot ? { number: me } : undefined);

signal.onMessage((m) => {
  if (m.direct && m.from === me) signal.send(`you said: ${m.text}`);   // YOU decide who may talk to it
});
await signal.connect();
```

## API

**`SignalClient`**
- `onMessage(h)` receives `IncomingMessage { from, text, timestamp, direct, quote?, audio?, group?, addressedToMe?, fromUuid?, fromName? }`. `direct` means a private one-to-one conversation with the bot (Note to Self, or its own chat), never a group. Mentions arrive as `@name` in `text`.
- `onReaction(h)` receives `IncomingReaction { from, emoji, targetTimestamp, targetAuthor?, isRemove, direct }`. `isOwnReaction(r)` recognises the bot's own reactions when they echo back (in Note to Self they look exactly like the person's).
- `send(text, textStyle?, quote?, { attachments?, groupId? })` returns the sent message's timestamp. `textStyle` is signal-cli's `start:length:STYLE` strings; `quote` threads a reply; an audio attachment is shown as a voice message; `groupId` sends to a group instead.
- `react(emoji, { author, timestamp }, groupId?)`, `markRead(timestamp, from?)` (the "seen" check; `from` is the message's author, which in a group is not the peer), `typing(stop?, groupId?)`: best effort, never throw. `markRead` and `typing` are own-account mode only.
- `groups()` lists the groups the bot is in with their members (number and account id).
- `separateAccount` tells which mode you are in.

**Groups** (own-account mode): a group message has `group: { id }` and `direct: false`. `addressedToMe` is true when it @mentions the bot or replies to one of its messages, so a bot can stay silent otherwise. The package never decides who may talk to the bot: check `from`/`fromUuid` and the group's members yourself.

**Voice**
- In: `parseAudio` accepts only a plain audio attachment id (no paths) under 25 MB; `transcribe(file, whisperModelPath)` turns it into text locally with ffmpeg and [whisper.cpp](https://github.com/ggerganov/whisper.cpp); `voiceReady(model)` says what is missing.
- Out: `synthesize(text, { dir, voice, speed })` makes an AAC voice message locally with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) (its Python environment and model live in `dir`; the app's `scripts/setup-tts.sh` installs them); `ttsReady(dir)` says what is missing. Send the file with `send("", [], undefined, { attachments: [file] })`.

**Also exported:** `interpretEnvelope(envelope, { account, peer?, peerAci? })` (the pure function behind the receiving side; start here to understand or test it), `withMentions`, `parseQuote`, `ensureSignalDaemon(account, host, port, logFd?)` (localhost only: signal-cli's socket is unauthenticated; if the daemon dies the process exits so a supervisor restarts everything).

## Files

`src/client.ts` the client and `interpretEnvelope` · `src/daemon.ts` daemon supervision · `src/transcribe.ts` speech to text · `src/tts.ts` + `scripts/kokoro-say.py` text to speech · `test/` run with `npm test` in this folder.

Not yet published to npm; the name and scope are placeholders.
