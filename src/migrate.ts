import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

// One-time move of files that used to live in state/ and now belong in logs/ or memory/.
// Idempotent: a file is moved only if it is at its OLD place and not yet at its new one, so
// running it on every start is safe, and an already-migrated install is left alone.

// Pure mapping: where does a file that sits in the old state/ folder belong now?
// Returns a path relative to the data root, or undefined if it stays in state/.
export function newPlaceOf(name: string): string | undefined {
  if (/^agent\.log(\.\d+)?$/.test(name)) return `logs/${name}`;
  if (/^audit\.jsonl(\.\d+)?$/.test(name)) return `logs/${name}`;
  if (name === "signal-daemon.log" || name === "launchd-stderr.log") return `logs/${name}`;
  if (name === "last-brief.md") return `memory/${name}`;
  return undefined;
}

// Returns the relative paths it moved (to log them), never throws.
export function migrateLegacyLayout(dataDir: string): string[] {
  const moved: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(join(dataDir, "state"));
  } catch {
    return moved; // no state/ yet: a fresh install
  }
  for (const name of names) {
    const to = newPlaceOf(name);
    if (!to) continue;
    const target = join(dataDir, to);
    try {
      if (existsSync(target)) continue;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(join(dataDir, "state", name), target);
      moved.push(to);
    } catch { /* leave it where it is; the next start tries again */ }
  }
  return moved;
}
