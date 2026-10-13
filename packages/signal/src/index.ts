// The public API of @ted-personal-assistant/signal. See README.md.
export { SignalClient, parseQuote, parseAudio, parseImage, withMentions, interpretEnvelope, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES } from "./client.ts";
export type { Quote, IncomingMessage, IncomingReaction, AudioRef, ImageRef } from "./client.ts";
export { ensureSignalDaemon } from "./daemon.ts";
export { synthesize, ttsReady, isVoiceSpec, MAX_SPOKEN_CHARS, type TtsConfig } from "./tts.ts";
export { synthesizeWith, providerReady, type TtsProviderConfig, type TtsFallback } from "./tts-provider.ts";
export { isSafeUrl, sniffAudio } from "./tts-remote.ts";
export { ELEVENLABS_BASE } from "./tts-elevenlabs.ts";
export { transcribe, voiceReady, cleanTranscript } from "./transcribe.ts";
