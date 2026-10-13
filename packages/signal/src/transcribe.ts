import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Voice messages are transcribed on this machine: ffmpeg turns the recording into 16 kHz mono audio,
// whisper.cpp (the open-source port of OpenAI's Whisper) turns that into text. No network, no
// API key, no model call.

const run = promisify(execFile);
const TIMEOUT_MS = 120_000;
const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";

// Whisper marks silence and noise in brackets or parentheses; keep only the words.
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// What is missing for transcription: ffmpeg, whisper-cli, or the model file.
export function voiceReady(model: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const onPath = (bin: string) => `${process.env.PATH ?? ""}:${EXTRA_PATH}`.split(":").some((d) => d && existsSync(join(d, bin)));
  if (!onPath("ffmpeg")) missing.push("ffmpeg");
  if (!onPath("whisper-cli")) missing.push("whisper-cli (brew install whisper-cpp)");
  if (!existsSync(model)) missing.push(`model ${model}`);
  return { ok: missing.length === 0, missing };
}

// `file`: any audio file ffmpeg can read. `model`: a whisper.cpp ggml model file.
export async function transcribe(file: string, model: string): Promise<string> {
  if (!existsSync(file)) throw new Error("the recording is not on disk");
  const dir = await mkdtemp(join(tmpdir(), "voice-"));
  const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}` };
  try {
    const wav = join(dir, "in.wav");
    await run("ffmpeg", ["-v", "error", "-i", file, "-ar", "16000", "-ac", "1", "-f", "wav", wav], { timeout: TIMEOUT_MS, env });
    const { stdout } = await run("whisper-cli", ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np"], { timeout: TIMEOUT_MS, env, maxBuffer: 4_000_000 });
    return cleanTranscript(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
