// The public API of @ted-personal-assistant/signal. See README.md.
export { SignalClient, parseQuote, parseAudio, withMentions, interpretEnvelope, MAX_AUDIO_BYTES } from "./client.ts";
export type { Quote, IncomingMessage, IncomingReaction, AudioRef } from "./client.ts";
export { ensureSignalDaemon } from "./daemon.ts";
export { synthesize, ttsReady, MAX_SPOKEN_CHARS, type TtsConfig } from "./tts.ts";
export { transcribe, voiceReady, cleanTranscript } from "./transcribe.ts";
