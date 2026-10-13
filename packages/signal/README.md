# @number-one/signal

A small, typed client for [signal-cli](https://github.com/AsamK/signal-cli)'s JSON-RPC daemon, extracted from the Number One assistant. Zero dependencies, Node 24+ (runs TypeScript directly).

It supports two ways of talking to a person, chosen by one constructor argument:

| Mode | The assistant is | The person sees | Constructed with |
|---|---|---|---|
| **Note to Self** (default) | a linked device of *their* Signal account | a chat with themselves | `new SignalClient(host, port, theirNumber)` |
| **Own account** | a separate Signal account with its own name | a contact they chat with | `new SignalClient(host, port, assistantAccount, { number: theirNumber })` |

Own-account mode needs a Signal account for the assistant: a spare number, or Signal Login (no number, Android). See the app's [SIGNAL-ACCOUNT.md](../../docs/SIGNAL-ACCOUNT.md) for creating and naming it with signal-cli.

## Use

```ts
import { SignalClient, ensureSignalDaemon } from "@number-one/signal";

const me = process.env.SIGNAL_NUMBER!;        // your number, international format
const bot = process.env.SIGNAL_ACCOUNT;       // optional: the assistant's own account (number or account key)

await ensureSignalDaemon(bot ?? me, "127.0.0.1", 7583);   // starts and supervises `signal-cli daemon`
const signal = new SignalClient("127.0.0.1", 7583, bot ?? me, bot ? { number: me } : undefined);

signal.onMessage((m) => {
  if (m.direct && m.from === me) signal.send(`you said: ${m.text}`); // YOU decide who may talk to it
});
signal.onReaction((r) => {
  if (signal.isOwnReaction(r)) return;        // our own status icons come back as reactions
  console.log(r.emoji, "on message", r.targetTimestamp, "by", r.targetAuthor);
});
await signal.connect();
```

## API

- **`SignalClient`**
  - `onMessage(h)`, `onReaction(h)`: `IncomingMessage { from, text, timestamp, direct, quote?, audio? }` and `IncomingReaction { from, emoji, targetTimestamp, isRemove, direct, targetAuthor? }`. **`direct`** means a one-to-one conversation with the assistant: your Note to Self (default mode) or the assistant's own chat with you (own-account mode). Groups and other people's chats are never `direct`. Filter on it and on `from`.
  - `send(text, textStyle?, quote?)` → the sent message's timestamp. `textStyle` is signal-cli's `start:length:STYLE` strings; `quote` threads the reply under a message.
  - `react(emoji, { author, timestamp })`: best effort; a new reaction replaces the previous one, so it works as a status icon. `isOwnReaction(r)` recognises our own reactions when they echo back (in Note to Self they look exactly like the person's).
  - `typing(stop?)`: the "typing…" indicator. Own-account mode only (Signal does not show it in Note to Self); a no-op otherwise.
  - `separateAccount`: which mode you are in.
- **`interpretEnvelope(envelope, { account, peer?, peerAci? })`**: the pure function behind the above, exported for tests. In Note to Self mode the person's messages arrive as something they sent from another device; in own-account mode they are ordinary incoming messages, matched to the person by number, or by account id (`peerAci`) when Signal hides their number.
- **Voice notes**: attachments are parsed safely (`parseAudio`: plain file ids only, no paths, capped at 25 MB). `transcribe(file, modelPath)` turns audio into text locally with ffmpeg and whisper.cpp, nothing leaves the machine; `voiceReady(modelPath)` says what is missing.
- **`parseQuote`**, **`ensureSignalDaemon(account, host, port, logFd?)`**: the daemon listens on 127.0.0.1 only (its socket is unauthenticated); if it dies, the process exits so a supervisor can restart everything.

## Safety

The client does not decide who may talk to your assistant. It reports `from` and `direct`; the application must check both against the one person it serves (the app does, in `src/guards.ts`). In own-account mode only the configured number or account id is ever `direct`.

Not yet published to npm; the name and scope are placeholders. Tests: `npm test` at the repo root runs `test/*.test.ts` in this package too.
