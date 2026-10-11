// Import this FIRST (for its side effects).
//  - owner-only files: everything the harness creates is mode 600/700 (the audit log holds senders and subjects)
//  - every console line gets a local timestamp, is redacted, and is appended to a rotating file
//  - crashes and unhandled rejections are written to that same file before the process exits
process.umask(0o077);

import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { settings } from "./settings.ts";

const DIR = settings.stateDir;
const FILE = join(DIR, "agent.log");
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
mkdirSync(DIR, { recursive: true, mode: 0o700 });

// Tighten state/ on every start: files created by others (launchd's stderr file, an older
// version of the agent) may have been made with looser permissions.
try {
  chmodSync(DIR, 0o700);
  for (const f of readdirSync(DIR)) chmodSync(join(DIR, f), 0o600);
} catch { /* best effort */ }

let writes = 0;
function rotateIfNeeded() {
  try {
    if (statSync(FILE).size < MAX_BYTES) return;
    rmSync(`${FILE}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      try { renameSync(`${FILE}.${i}`, `${FILE}.${i + 1}`); } catch { /* missing is fine */ }
    }
    renameSync(FILE, `${FILE}.1`);
  } catch { /* no file yet */ }
}
rotateIfNeeded();

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function stamp(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

for (const level of ["log", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const text = redact(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(" "));
    const line = `${stamp()} ${level === "error" ? "ERR " : ""}${text}`;
    if (process.stdout.isTTY) original(line); // under launchd the file below is the log
    try {
      appendFileSync(FILE, line + "\n");
      if (++writes % 200 === 0) rotateIfNeeded();
    } catch { /* logging must never crash the agent */ }
  };
}

// Let launchd restart us, but leave a trace of why.
process.on("uncaughtException", (e) => {
  console.error("FATAL uncaught exception:", e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("FATAL unhandled rejection:", e);
  process.exit(1);
});
