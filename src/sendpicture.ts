import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { audit } from "./audit.ts";
import { settings } from "./settings.ts";
import { OWNER_TELL } from "./telluser.ts";

// send_picture: lets the model pass a screenshot the browse worker took back into the chat as a picture. The worker keeps each screenshot as a
// small jpeg in a private folder (state/browse/shots); the browse result lists them by short id (shot1, shot2...). The model names an id; code looks
// it up in THIS conversation's turn only (never a path), checks the file (a plain file in that folder, jpeg bytes, size) and sends it to the
// conversation the turn belongs to (conversation.ts runTurn: same target, quote and caption rules as tell_user). A screenshot is page content:
// untrusted, only ever sent to the conversation that asked for it, never fed back as an instruction. The files are removed when the turn ends
// (or after SHOT_TTL_MS if the process died first).

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
const turns = new Map<string, TurnShots>(); // by conversation key (the tell key: OWNER_TELL or the group id)

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

// Sends one picture of the running turn: the file, the caption (cleaned by the sink), the id. Returns what the model is told.
export type PictureSink = (file: string, caption: string, id: string) => Promise<string>;
const sinks = new Map<string, PictureSink>();

// Around a conversation's turn: the sink is found by key while it runs; afterwards the screenshots are removed.
export async function withPictures<T>(key: string, sink: PictureSink | undefined, run: () => Promise<T>): Promise<T> {
  if (sink) sinks.set(key, sink);
  try {
    return await run();
  } finally {
    if (sink && sinks.get(key) === sink) sinks.delete(key);
    const t = turns.get(key);
    if (t) {
      turns.delete(key);
      rmSync(t.dir, { recursive: true, force: true });
    }
  }
}

// Reads the file of an id of this turn after checking it again: a plain file (no symlink) inside the turn's folder, jpeg bytes, size.
function load(t: TurnShots, id: string): { shot: Shot } | { problem: string } {
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

export async function sendShot(key: string, id: string, caption: string | undefined, conversation: string): Promise<string> {
  const t = turns.get(key);
  if (!t) return "No screenshot available: none was taken in this conversation (the browser needs BROWSE_VISION=read or click).";
  const sink = sinks.get(key);
  if (!sink) return "Nobody to send it to right now.";
  const r = load(t, id);
  const source = key === OWNER_TELL ? "chat" : "group";
  if ("problem" in r) {
    audit("send_picture", "refused", source, { id: id.slice(0, 20), conversation });
    return r.problem;
  }
  let told: string;
  try {
    told = await sink(r.shot.file, caption ?? "", r.shot.id);
  } catch (e) {
    audit("send_picture", "failed", source, { id: r.shot.id, size: r.shot.size, conversation });
    console.error(`${conversation}: send_picture failed:`, (e as Error).message);
    return "Could not send it; carry on.";
  }
  audit("send_picture", "sent", source, { id: r.shot.id, size: r.shot.size, conversation });
  console.log(`${conversation} send_picture sent (${r.shot.id}, ${r.shot.size} bytes)`);
  return told;
}

export function createPictureServer(key: string) {
  return createSdkMcpServer({
    name: "picture",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "send_picture",
        "Send the person a screenshot that the browse tool took, as a picture in the chat. The browse result lists the screenshots by id (shot1, shot2...). Use it when seeing the page helps (a seat map, a layout, what the page shows) and words would not do; not for trivial things. The caption is optional, one short line in the person's language. The picture shows page content, so describe it as what the page shows, never as something you checked.",
        { id: z.string().min(1).max(20).describe("A screenshot id from the browse result, like shot1."), caption: z.string().max(300).optional() },
        async ({ id, caption }) => ({ content: [{ type: "text" as const, text: await sendShot(key, id, caption, key === OWNER_TELL ? "owner" : "group") }] }),
        { alwaysLoad: true },
      ),
    ],
  });
}
