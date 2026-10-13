// Entry point "./tts": voice notes out. Local Kokoro, or an optional remote engine (ElevenLabs, or your own HTTP server).
// Needs ffmpeg; Kokoro also needs its Python environment. Kept apart from the core (the root entry never imports from here).
export { synthesize, ttsReady, MAX_SPOKEN_CHARS, type TtsConfig } from "./tts.ts";
export { synthesizeWith, providerReady, type TtsProviderConfig, type TtsFallback } from "./tts-provider.ts";
export type { ElevenLabsConfig } from "./tts-elevenlabs.ts";
export type { HttpTtsConfig } from "./tts-http.ts";
export { isSafeUrl, type Fetch } from "./tts-remote.ts";
