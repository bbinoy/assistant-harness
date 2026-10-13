# @number-one/signal

A small, typed client for [signal-cli](https://github.com/AsamK/signal-cli)'s JSON-RPC daemon, extracted from the Number One assistant. Zero dependencies, Node 24+ (runs TypeScript directly).

- **`SignalClient`**: connect to the daemon's socket; receive messages and reactions; send to your own *Note to Self* with text styles and quote-replies; react to a message; tell your own reactions from the owner's (`isOwnReaction`, because in Note to Self they look identical).
- **Voice notes**: incoming audio attachments are parsed safely (`parseAudio`: plain file ids only, size-capped) and `transcribe(file, model)` turns them into text locally with ffmpeg and whisper.cpp. Nothing leaves the machine.
- **`ensureSignalDaemon`**: starts and supervises `signal-cli daemon` on 127.0.0.1 (its socket is unauthenticated, so never anywhere else).

```ts
import { SignalClient, ensureSignalDaemon } from "@number-one/signal";

const me = process.env.SIGNAL_NUMBER!; // your number, in international format
await ensureSignalDaemon(me, "127.0.0.1", 7583);
const signal = new SignalClient("127.0.0.1", 7583, me);
signal.onMessage((m) => m.direct && signal.send(`you said: ${m.text}`));
await signal.connect();
```

It does not decide who may talk to your assistant: filter on `direct` and the sender yourself (the app does, in `src/guards.ts`).

Not yet published to npm; the name and scope are placeholders.
