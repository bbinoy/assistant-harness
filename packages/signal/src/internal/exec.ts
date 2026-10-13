import { existsSync } from "node:fs";
import { join } from "node:path";

// Where the helper programs (ffmpeg, whisper-cli) are looked for besides PATH: a launchd service has a thin PATH
// that lacks Homebrew.
export const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

// The environment for a child process, with the extra directories appended to PATH.
export function toolEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: [process.env.PATH ?? "", ...EXTRA_BIN_DIRS].join(":") };
}

// Whether a program is found on PATH or in the extra directories.
export function onPath(bin: string): boolean {
  return (toolEnv().PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
}
