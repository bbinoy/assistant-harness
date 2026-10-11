import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "./settings.ts";

// Everything the agent remembers lives in small files under state/ (owner-only).
//
// All access is synchronous on purpose. The files are tiny, and a synchronous
// read-modify-write cannot be interleaved with anything else in Node's event loop, so
// two callers can never lose each other's update. Writes go to a temporary file and are
// renamed into place, so a crash mid-write leaves the old version, never a torn file.

export const statePath = (name: string) => join(settings.stateDir, name);

function ensureDir() {
  mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
}

export function readText(name: string): string | undefined {
  try {
    return readFileSync(statePath(name), "utf8");
  } catch {
    return undefined;
  }
}

export function writeText(name: string, text: string): void {
  ensureDir();
  const path = statePath(name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(name: string, fallback: T): T {
  const raw = readText(name);
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`state: ${name} is unreadable, starting from defaults`);
    return fallback;
  }
}

export function writeJson(name: string, value: unknown): void {
  writeText(name, JSON.stringify(value));
}

export function appendLine(name: string, line: string): void {
  ensureDir();
  appendFileSync(statePath(name), line + "\n", { mode: 0o600 });
}
