import { synthesize, ttsReady, type TtsConfig } from "./tts.ts";
import { synthesizeElevenLabs, type ElevenLabsConfig } from "./tts-elevenlabs.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { synthesizeHttp, type HttpTtsConfig } from "./tts-http.ts";

// Which engine speaks: Kokoro on this machine (the default, nothing leaves it), or a remote one by choice.
// Every provider returns the path of an .m4a in a fresh temp folder, or throws; the caller then sends text.

export type TtsFallback = "none" | "kokoro";

export type TtsProviderConfig = { kokoro: TtsConfig; fallback: TtsFallback } & (
  | { provider: "kokoro" }
  | { provider: "elevenlabs"; elevenlabs: ElevenLabsConfig }
  | { provider: "http"; http: HttpTtsConfig }
);

// What is missing for speech with this provider. A remote provider needs only ffmpeg (its settings were checked at start-up).
export function providerReady(cfg: TtsProviderConfig): { ok: boolean; missing: string[] } {
  const local = ttsReady(cfg.kokoro.dir);
  if (cfg.provider === "kokoro") return local;
  return { ok: !local.missing.includes("ffmpeg"), missing: local.missing.filter((m) => m === "ffmpeg") };
}

export async function synthesizeWith(text: string, cfg: TtsProviderConfig, log: Logger = silentLogger): Promise<string> {
  if (cfg.provider === "kokoro") return synthesize(text, cfg.kokoro);
  try {
    return await (cfg.provider === "elevenlabs" ? synthesizeElevenLabs(text, cfg.elevenlabs) : synthesizeHttp(text, cfg.http));
  } catch (e) {
    // Only when the owner asked for it (TTS_FALLBACK=kokoro): the same words, spoken locally. Never a silent switch otherwise.
    if (cfg.fallback !== "kokoro" || !ttsReady(cfg.kokoro.dir).ok) throw e;
    log.warn(`${cfg.provider} speech failed, using Kokoro:`, (e as Error).message);
    return synthesize(text, cfg.kokoro);
  }
}
