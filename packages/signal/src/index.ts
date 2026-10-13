// The core of @ted-personal-assistant/signal: the signal-cli client and daemon. See README.md.
// Optional parts are separate entry points: "./voice" (transcription), "./tts" (speech), "./testing" (a fake daemon).
export { SignalClient, attachmentPath, defaultAttachmentsDir, parseQuote, parseAudio, parseImage, withMentions, interpretEnvelope, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES } from "./client.ts";
export type { SignalClientOptions, SendOptions, CloseInfo, Channel, Quote, IncomingMessage, IncomingReaction, AudioRef, ImageRef } from "./client.ts";
export { ensureSignalDaemon, type SignalDaemon, type DaemonOptions } from "./daemon.ts";
export { silentLogger, type Logger } from "./logger.ts";
