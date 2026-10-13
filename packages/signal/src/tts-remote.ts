import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Shared parts of the optional remote speech providers (tts-elevenlabs.ts, tts-http.ts): a bounded HTTPS
// request, a check that what came back is audio, and the same ffmpeg step to AAC as the local voice.
// The text sent is only the words Ted would speak; keys and tokens come from settings and are never logged.

const run = promisify(execFile);
const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export type Fetch = typeof fetch;
export type AudioKind = "wav" | "mp3" | "ogg";

// A remote endpoint is plain HTTPS, except on this machine, where http is fine for testing. Pure.
export const isSafeUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
};

// Audio format from the content type, else from the first bytes. Pure. Undefined: not audio we know.
export function sniffAudio(contentType: string | null, bytes: Uint8Array): AudioKind | undefined {
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^audio\/(wav|x-wav|wave|vnd\.wave)$/.test(ct)) return "wav";
  if (/^audio\/(mpeg|mp3)$/.test(ct)) return "mp3";
  if (/^audio\/(ogg|opus)$/.test(ct) || ct === "application/ogg") return "ogg";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  return undefined;
}

// A short, safe description of a failed request: status and a bit of the body, with the secrets blanked out.
// 401/403 mean a wrong key; 402/429 a quota or rate limit; the reason is in the message either way.
function describe(status: number, body: string, secrets: string[]): string {
  let text = body.replace(/\s+/g, " ").slice(0, 160);
  for (const s of secrets) if (s) text = text.split(s).join("***");
  const why = status === 401 || status === 403 ? " (key or token refused)" : status === 402 || status === 429 ? " (quota or rate limit)" : "";
  return `HTTP ${status}${why}${text ? `: ${text}` : ""}`;
}

export interface RemoteRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  secrets: string[]; // blanked out of any error message
  timeoutMs: number;
  fetchImpl?: Fetch;
}

// POSTs the request, checks the answer is audio, and returns it as an AAC voice message in a fresh temp folder
// (the caller deletes that folder, like for the local voice). Any timeout, HTTP error or non-audio answer throws.
export async function synthesizeRemote(req: RemoteRequest, name: string): Promise<string> {
  let res: Response;
  try {
    res = await (req.fetchImpl ?? fetch)(req.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...req.headers },
      body: JSON.stringify(req.body),
      redirect: "error", // a redirect could carry the token to another host
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (e) {
    const x = e as { name?: string; message: string };
    throw new Error(`${name} request failed: ${x.name === "TimeoutError" || x.name === "AbortError" ? `timeout after ${Math.round(req.timeoutMs / 1000)} s` : "network error"}`);
  }
  if (!res.ok) throw new Error(`${name} ${describe(res.status, await res.text().catch(() => ""), req.secrets)}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error(`${name} answer too large (${declared} bytes)`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) throw new Error(`${name} answer has ${bytes.length} bytes`);
  const kind = sniffAudio(res.headers.get("content-type"), bytes);
  if (!kind) throw new Error(`${name} answer is not wav, mp3 or ogg audio (content type ${res.headers.get("content-type") ?? "none"})`);
  const dir = await mkdtemp(join(tmpdir(), "speech-"));
  const raw = join(dir, `remote.${kind}`);
  const out = join(dir, "voice.m4a");
  await writeFile(raw, bytes, { mode: 0o600 });
  const env = { ...process.env, PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}` };
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-i", raw, "-c:a", "aac", "-b:a", "64k", out], { timeout: 60_000, env });
  } catch (e) {
    throw new Error(`ffmpeg failed: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split("\n").slice(-3).join(" | ").slice(0, 200)}`);
  }
  return out;
}
