import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { settings } from "./settings.ts";
import type { AudioRef } from "./signal.ts";

// Voice messages are transcribed on this Mac: ffmpeg turns the recording into 16 kHz mono audio,
// whisper.cpp (the open-source port of OpenAI's Whisper) turns that into text. No network, no
// API key, no model call. The transcript is then handled like anything the owner typed, except
// that it can never answer an approval (main.ts).

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;

// Whisper marks silence and noise in brackets or parentheses; keep only the words.
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function voiceReady(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const onPath = (bin: string) => (process.env.PATH ?? "").split(":").concat(["/opt/homebrew/bin", "/usr/local/bin"]).some((d) => d && existsSync(join(d, bin)));
  if (!onPath("ffmpeg")) missing.push("ffmpeg");
  if (!onPath("whisper-cli")) missing.push("whisper-cli (brew install whisper-cpp)");
  if (!existsSync(settings.whisperModel)) missing.push(`model ${settings.whisperModel}`);
  return { ok: missing.length === 0, missing };
}

export async function transcribe(audio: AudioRef): Promise<string> {
  const source = join(settings.signalAttachmentsDir, audio.id);
  if (!existsSync(source)) throw new Error("the recording is not on disk");
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` };
  try {
    const wav = join(dir, "in.wav");
    await run("ffmpeg", ["-v", "error", "-i", source, "-ar", "16000", "-ac", "1", "-f", "wav", wav], { timeout: TIMEOUT_MS, env });
    const { stdout } = await run("whisper-cli", ["-m", settings.whisperModel, "-f", wav, "-l", "auto", "-nt", "-np"], { timeout: TIMEOUT_MS, env, maxBuffer: 4_000_000 });
    return cleanTranscript(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
