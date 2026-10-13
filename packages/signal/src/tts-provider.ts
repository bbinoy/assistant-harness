import { synthesize, ttsReady, type TtsConfig } from "./tts.ts";
import { synthesizeElevenLabs, type ElevenLabsConfig } from "./tts-elevenlabs.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { synthesizeHttp, type HttpTtsConfig } from "./tts-http.ts";

// Which engine speaks: Kokoro on this machine (the default, nothing leaves it), or a remote one by choice.
// Every provider returns the path of an .m4a in a fresh temp folder, or throws; the caller then sends text.

/** What happens when a remote engine fails: "none" (the call throws) or "kokoro" (the same words, spoken locally). */
export type TtsFallback = "none" | "kokoro";

/** Which engine speaks, with its settings. `kokoro` is always needed (it is also the optional fallback). */
export type TtsProviderConfig = { kokoro: TtsConfig; fallback: TtsFallback } & (
  | { provider: "kokoro" }
  | { provider: "elevenlabs"; elevenlabs: ElevenLabsConfig }
  | { provider: "http"; http: HttpTtsConfig }
);

/** What is missing for speech with this provider. A remote provider needs only ffmpeg. */
export function providerReady(cfg: TtsProviderConfig): { ok: boolean; missing: string[] } {
  const local = ttsReady(cfg.kokoro.dir);
  if (cfg.provider === "kokoro") return local;
  return { ok: !local.missing.includes("ffmpeg"), missing: local.missing.filter((m) => m === "ffmpeg") };
}

/**
 * Speaks `text` with the configured engine and returns the path of an .m4a in a fresh temp folder, which the caller
 * deletes after sending. A remote engine sends the text to a third party. A failed remote request throws, unless
 * `fallback` is "kokoro" and Kokoro is set up; a silent switch never happens otherwise.
 */
export async function synthesizeWith(text: string, cfg: TtsProviderConfig, log: Logger = silentLogger): Promise<string> {
  if (cfg.provider === "kokoro") return synthesize(text, cfg.kokoro);
  try {
    return await (cfg.provider === "elevenlabs" ? synthesizeElevenLabs(text, cfg.elevenlabs) : synthesizeHttp(text, cfg.http));
  } catch (e) {
    // Only when asked for (fallback: "kokoro"): the same words, spoken locally.
    if (cfg.fallback !== "kokoro" || !ttsReady(cfg.kokoro.dir).ok) throw e;
    log.warn(`${cfg.provider} speech failed, using Kokoro:`, (e as Error).message);
    return synthesize(text, cfg.kokoro);
  }
}
