import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOptions } from "../src/agentrun.ts";
import { BrowseGuard } from "../src/browseguard.ts";
import { sanitizeResult, shotCaptions } from "../src/browse.ts";
import { createPipeline, group, owner } from "../src/conversation.ts";
import { createOutbound } from "../src/outbound.ts";
import { classify } from "../src/policy.ts";
import { adoptShots, newShotsDir, sendShot, SHOT_TTL_MS, sweepShots, withPictures } from "../src/sendpicture.ts";
import { OWNER_TELL } from "../src/telluser.ts";
import { flagFor } from "../src/toolmanifest.ts";

// send_picture: a screenshot of THIS turn's browse run, as a picture in the conversation that asked.

const TOOL = "mcp__picture__send_picture";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const jpegResponse = (b: Buffer) => ({ content: [{ type: "text", text: "### Result" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b.toString("base64") } }] });

function shotsFrom(files: Buffer[]) {
  const dir = newShotsDir();
  const guard = new BrowseGuard({ mode: "owner", task: "t", outDir: dir, shotsDir: dir, vision: "read" });
  for (const f of files) guard.keepShot(jpegResponse(f));
  return guard;
}

test("send_picture: manifest and policy: chat and group only, never background or unattended", () => {
  assert.equal(flagFor(TOOL, "chat"), "no");
  assert.equal(classify(TOOL, { id: "shot1" }, "chat"), "allow");
  assert.equal(classify(TOOL, { id: "shot1" }, "group"), "allow");
  for (const source of ["brief", "radar", "handler", "heartbeat", "dream", "browse", "background"] as const) {
    assert.equal(flagFor(TOOL, source), undefined, source);
    assert.equal(classify(TOOL, { id: "shot1" }, source), "deny", source);
  }
});

test("send_picture: only chat and group runs are given the tool server", () => {
  const base = { systemPrompt: "x", maxTurns: 1, maxBudgetUsd: 1 };
  const has = (o: Parameters<typeof buildOptions>[1]) => Object.keys(buildOptions(async () => ({ approved: true }), o, undefined).mcpServers ?? {}).includes("picture");
  assert.equal(has({ ...base, source: "chat", memory: { dir: "/tmp/n" } }), true);
  assert.equal(has({ ...base, source: "group", memory: { dir: "/tmp/n", groupId: "g1" } }), true);
  for (const source of ["brief", "radar", "handler", "background", "dream"] as const) assert.equal(has({ ...base, source }), false, source);
});

test("send_picture: the guard keeps only real jpeg bytes, under names code chooses", () => {
  const g = shotsFrom([JPEG, Buffer.from("not a picture at all"), JPEG]);
  assert.deepEqual(g.kept.map((k) => k.id), ["shot1", "shot2"]);
  assert.equal(new BrowseGuard({ mode: "owner", task: "t", outDir: "/tmp" }).keepShot(jpegResponse(JPEG)), undefined); // vision off: nothing kept
});

test("send_picture: an id of this turn is sent; another id, a path and a traversal are refused; the files go when the turn ends", async () => {
  const g = shotsFrom([JPEG]);
  const sent: string[] = [];
  let file = "";
  await withPictures(OWNER_TELL, async (f, _c, id) => (sent.push(id), (file = f), "ok"), async () => {
    const shots = adoptShots(OWNER_TELL, g.kept, { shot1: "the seat map" });
    assert.deepEqual(shots.map((s) => [s.id, s.caption]), [["shot1", "the seat map"]]);
    for (const bad of ["shot2", "../shot1", "/etc/passwd", "shot1.jpg", "../../x", "SHOT1", ""]) assert.match(await sendShot(OWNER_TELL, bad, undefined, "owner"), /No screenshot/, bad);
    assert.equal(await sendShot(OWNER_TELL, "shot1", "Here", "owner"), "ok");
    assert.deepEqual(sent, ["shot1"]);
    assert.equal(existsSync(file), true);
  });
  assert.equal(existsSync(file), false);
  assert.match(await sendShot(OWNER_TELL, "shot1", undefined, "owner"), /No screenshot available/);
});

test("send_picture: another conversation's screenshots are not reachable", async () => {
  const g = shotsFrom([JPEG]);
  await withPictures("g-a", async () => "ok", async () => {
    adoptShots("g-a", g.kept, {});
    await withPictures("g-b", async () => assert.fail("must not send"), async () => assert.match(await sendShot("g-b", "shot1", undefined, "group"), /No screenshot available/));
  });
});

test("send_picture: a symlink or a non-jpeg file in place of the screenshot is refused", async () => {
  const outside = join(mkdtempSync(join(tmpdir(), "outside-")), "secret.jpg");
  writeFileSync(outside, JPEG);
  const g = shotsFrom([JPEG, JPEG]);
  await withPictures(OWNER_TELL, async () => assert.fail("must not send"), async () => {
    const [a, b] = adoptShots(OWNER_TELL, g.kept, {});
    writeFileSync(a!.file, "GIF89a not a jpeg");
    assert.match(await sendShot(OWNER_TELL, "shot1", undefined, "owner"), /not a jpeg/);
    rmSync(b!.file);
    symlinkSync(outside, b!.file);
    assert.match(await sendShot(OWNER_TELL, "shot2", undefined, "owner"), /cannot be used/);
  });
});

test("send_picture: old screenshot folders are swept after the TTL", () => {
  const dir = newShotsDir();
  sweepShots(Date.now());
  assert.equal(existsSync(dir), true);
  sweepShots(Date.now() + SHOT_TTL_MS + 60_000);
  assert.equal(existsSync(dir), false);
});

test("browse result: captions are cleaned and cut, odd ids dropped", () => {
  const c = shotCaptions({ shots: [{ id: "shot1", caption: "Seat map​" + "x".repeat(300) }, { id: "../x", caption: "bad" }, "junk"] });
  assert.deepEqual(Object.keys(c), ["shot1"]);
  assert.equal(c.shot1!.length <= 120, true);
  assert.equal(sanitizeResult({ status: "done", answer: "a", sources: [], shots: [{ id: "shot9", caption: "x" }] }, "", { steps: 1, commits: 0 }).shots, undefined); // the result names only screenshots code kept
});

function rig() {
  const sent: { text: string; attachments?: string[]; groupId?: string }[] = [];
  const signal = {
    separateAccount: false,
    react: async () => {},
    typing: async () => {},
    markRead: async () => {},
    send: async (t: string, o: { attachments?: string[]; groupId?: string } = {}) => (sent.push({ text: t, attachments: o.attachments, groupId: o.groupId }), sent.length),
  };
  const record = () => {};
  const pipeline = createPipeline({
    signal: signal as any,
    out: createOutbound(signal as any, record),
    record,
    account: "+1",
    runOwner: async () => ({ text: "" }),
    picture: async () => assert.fail("no picture"),
    transcript: async () => "",
    speech: { ready: () => false, synth: async () => "", foreign: async () => undefined },
    approvals: { answer: async () => ({ outcome: "none" as const }), answerReaction: () => "ignored" },
    vouch: async () => true,
    isOwner: () => true,
    admitGroup: async () => {},
    wait: async () => {},
  });
  return { sent, pipeline };
}

test("send_picture: a group turn sends the picture to that group, the owner's turn to the owner's chat; the file is gone afterwards", async () => {
  for (const [conv, key, groupId] of [[group("g1"), "g1", "g1"], [owner(), OWNER_TELL, undefined]] as const) {
    const { sent, pipeline } = rig();
    const g = shotsFrom([JPEG]);
    let told = "";
    let file = "";
    await pipeline.runTurn(conv, {
      announce: false,
      run: async () => {
        file = adoptShots(key, g.kept, {})[0]!.file;
        told = await sendShot(key, "shot1", "[[voice]]  Here is the map ", key === OWNER_TELL ? "owner" : "group");
        return { text: "[[silent]]" };
      },
    });
    assert.match(told, /^Sent shot1/);
    assert.deepEqual(sent.map((s) => [s.text, s.attachments?.length, s.groupId]), [["Here is the map", 1, groupId]]);
    assert.equal(existsSync(file), false);
  }
});

test("send_picture: a reaction or wake-up turn has no way to send", async () => {
  const { sent, pipeline } = rig();
  for (const kind of [{ reaction: true }, { background: true }]) {
    const g = shotsFrom([JPEG]);
    let told = "";
    await pipeline.runTurn(owner(), {
      announce: false,
      ...kind,
      run: async () => {
        adoptShots(OWNER_TELL, g.kept, {});
        told = await sendShot(OWNER_TELL, "shot1", undefined, "owner");
        return { text: "" };
      },
    });
    assert.match(told, /Nobody to send/);
  }
  assert.equal(sent.length, 0);
});
