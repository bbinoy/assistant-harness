import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Text to speech, on this machine: Kokoro (an open-source neural voice model, run through onnx in its
// own Python environment) makes the audio, ffmpeg turns it into an AAC file, which Signal shows as a
// voice message. No network, no API key. `scripts/setup-tts.sh` in the app installs everything.

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../scripts/kokoro-say.py");
const TIMEOUT_MS = 90_000;
const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";

export const MAX_SPOKEN_CHARS = 700; // longer than this is not a voice message, it is a lecture

export interface TtsConfig {
  dir: string; // holds venv/, kokoro-v1.0.onnx and voices-v1.0.bin
  voice: string; // a Kokoro voice, like am_onyx
  speed: number; // 1 is normal
}

const files = (dir: string) => ({ python: join(dir, "venv/bin/python"), model: join(dir, "kokoro-v1.0.onnx"), voices: join(dir, "voices-v1.0.bin") });

// What is missing for speech: the Python environment, the model files, ffmpeg.
export function ttsReady(dir: string): { ok: boolean; missing: string[] } {
  const f = files(dir);
  const missing = Object.entries({ "Python environment": f.python, "Kokoro model": f.model, "Kokoro voices": f.voices }).filter(([, p]) => !existsSync(p)).map(([n]) => n);
  if (!`${process.env.PATH ?? ""}:${EXTRA_PATH}`.split(":").some((d) => d && existsSync(join(d, "ffmpeg")))) missing.push("ffmpeg");
  return { ok: missing.length === 0, missing };
}

// Speaks `text` and returns the path of an .m4a voice message in a fresh temp folder; the caller
// sends it and then deletes that folder (dirname of the path).
export async function synthesize(text: string, cfg: TtsConfig): Promise<string> {
  const f = files(cfg.dir);
  const dir = await mkdtemp(join(tmpdir(), "speech-"));
  const wav = join(dir, "say.wav");
  const out = join(dir, "voice.m4a");
  const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}` };
  const py = run(f.python, [SCRIPT, f.model, f.voices, cfg.voice, String(cfg.speed), wav], { timeout: TIMEOUT_MS, env });
  py.child.stdin?.end(text);
  await py;
  await run("ffmpeg", ["-v", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "64k", out], { timeout: TIMEOUT_MS, env });
  return out;
}
