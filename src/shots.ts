import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { settings } from "./settings.ts";

// Screenshots of a browse run, kept for the conversation's turn so the model can send one with the `send` tool (send.ts). The worker keeps each
// screenshot as a small jpeg in a private folder (state/browse/shots); the browse result lists them by short id (shot1, shot2...). The model names an
// id; code looks it up in THIS conversation's turn only (never a path) and checks the file again (a plain file in that folder, jpeg bytes, size).
// A screenshot is page content: untrusted, only ever sent to the conversation that asked for it, never fed back as an instruction. The files are
// removed when the turn ends (or after SHOT_TTL_MS if the process died first).

export const MAX_PICTURE_BYTES = 3_000_000;
export const SHOT_TTL_MS = 60 * 60_000;
const ID = /^shot[1-9]\d{0,2}$/;
const shotsRoot = () => join(settings.stateDir, "browse", "shots");

export const isJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

// A folder for one browse run's screenshots (the guard writes into it). Old ones are swept first.
export function newShotsDir(now = Date.now()): string {
  mkdirSync(shotsRoot(), { recursive: true, mode: 0o700 });
  sweepShots(now);
  return mkdtempSync(join(shotsRoot(), "run-"));
}

// Folders older than the TTL (a turn that never ended, a crash) go.
export function sweepShots(now = Date.now()): void {
  try {
    for (const n of readdirSync(shotsRoot())) {
      const p = join(shotsRoot(), n);
      try {
        if (now - statSync(p).mtimeMs > SHOT_TTL_MS) rmSync(p, { recursive: true, force: true });
      } catch {
        // gone already
      }
    }
  } catch {
    // no folder yet
  }
}

export interface Shot {
  id: string;
  file: string;
  size: number;
  caption: string;
}
interface TurnShots {
  dir: string;
  shots: Map<string, Shot>;
}
const turns = new Map<string, TurnShots>(); // by conversation key (OWNER_KEY or the group id)

// Takes the files of one browse run (a folder from newShotsDir) into the conversation's turn under new ids; returns them for the result.
export function adoptShots(key: string, from: { id: string; file: string; size: number }[], captions: Record<string, string>): Shot[] {
  if (!from.length) return [];
  let t = turns.get(key);
  if (!t) {
    mkdirSync(shotsRoot(), { recursive: true, mode: 0o700 });
    turns.set(key, (t = { dir: mkdtempSync(join(shotsRoot(), "turn-")), shots: new Map() }));
  }
  const out: Shot[] = [];
  for (const s of from) {
    const id = `shot${t.shots.size + 1}`;
    const file = join(t.dir, `${id}.jpg`);
    try {
      renameSync(s.file, file);
    } catch {
      continue;
    }
    const shot = { id, file, size: s.size, caption: captions[s.id] ?? "" };
    t.shots.set(id, shot);
    out.push(shot);
  }
  return out;
}

// The turn is over: its screenshots go.
export function dropShots(key: string): void {
  const t = turns.get(key);
  if (!t) return;
  turns.delete(key);
  rmSync(t.dir, { recursive: true, force: true });
}

// The file of an id of this turn, after checking it again: a plain file (no symlink) inside the turn's folder, jpeg bytes, size.
export function loadShot(key: string, id: string): { shot: Shot } | { problem: string } {
  const t = turns.get(key);
  if (!t) return { problem: "No screenshot available: none was taken in this conversation (the browser needs BROWSE_VISION=read or click)." };
  const shot = ID.test(id) ? t.shots.get(id) : undefined;
  if (!shot) return { problem: `No screenshot "${id}" in this conversation. The ids are the ones listed in the browse result.` };
  let fd: number | undefined;
  try {
    if (!shot.file.startsWith(t.dir + "/") || lstatSync(shot.file).isSymbolicLink()) return { problem: "That screenshot cannot be used." };
    fd = openSync(shot.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_PICTURE_BYTES || st.size < 5) return { problem: "That screenshot cannot be used (size)." };
    const head = Buffer.alloc(3);
    if (readSync(fd, head, 0, 3, 0) < 3) return { problem: "That screenshot is not a jpeg picture." };
    if (!isJpeg(head)) return { problem: "That screenshot is not a jpeg picture." };
    return { shot: { ...shot, size: st.size } };
  } catch {
    return { problem: "That screenshot is gone." };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
