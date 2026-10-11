import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { missingSetup, SETUP_ITEMS, type Note } from "../src/notes.ts";
import { briefSystem, chatSystem, handlerSystem } from "../src/persona.ts";
import { settings } from "../src/settings.ts";

const skillsDir = join(settings.pluginDir, "skills");
const skills = readdirSync(skillsDir);

test("plugin: manifest is valid and every skill has a name and description matching its folder", () => {
  const manifest = JSON.parse(readFileSync(join(settings.pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "number-one");
  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
    const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(text);
    assert.ok(front, `${s}: front matter`);
    assert.equal(front![1], s, `${s}: name matches folder`);
  }
  for (const s of ["daily-brief", "mailbird", "mailbird-troubleshooting", "calendar", "notion-tasks", "meeting-prep", "setup"]) assert.ok(skills.includes(s), s);
});

test("plugin: skills hold no personal details, only references to the owner's notes", () => {
  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /TODO\(owner\)/, `${s}: unfilled template marker`);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, `${s}: an email address`);
    assert.doesNotMatch(text, /notion\.(com|so)\/[\w-]*[0-9a-f]{20,}/i, `${s}: a Notion page id`);
    assert.doesNotMatch(text, /\[\[/, `${s}: wiki-link instead of a namespaced skill name`);
  }
});

test("plugin: every skill that needs setup names the note it reads, and setup saves under those names", () => {
  const setup = readFileSync(join(skillsDir, "setup", "SKILL.md"), "utf8");
  for (const item of SETUP_ITEMS) assert.ok(setup.includes(item.file), `setup skill saves ${item.file}`);
  for (const [skill, note] of [["calendar", "setup-calendars"], ["notion-tasks", "setup-tasks"], ["meeting-prep", "setup-meetings"], ["mailbird", "voice-writing"]] as const) {
    assert.ok(readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8").includes(note), `${skill} reads ${note}`);
  }
  assert.ok(existsSync(join(settings.pluginDir, ".claude-plugin", "plugin.json")));
});

test("setup: missing items are listed, in prompts as an offer in chat and a skip-and-say elsewhere", () => {
  const note = (file: string): Note => ({ file, category: file.startsWith("voice") ? "voice" : "setup", text: "x" });
  assert.equal(missingSetup([]).length, SETUP_ITEMS.length);
  assert.deepEqual(missingSetup(SETUP_ITEMS.map((i) => note(i.file))), []);
  assert.equal(missingSetup([note("setup-calendars.md")]).length, SETUP_ITEMS.length - 1);
  const missing = missingSetup([]);
  assert.match(chatSystem(undefined, new Date("2026-10-12T09:00:00"), missing), /number-one:setup skill\. For the Notion task list and meeting notes, find them yourself and save them, and ask .* only if you find nothing or several candidates/);
  assert.match(briefSystem("", missing), /You cannot ask anyone[\s\S]*message "set up"/);
  assert.match(handlerSystem("", missing), /Not set up yet/);
  assert.ok(!chatSystem(undefined, new Date(), []).includes("Not set up yet"));
});

test("setup: Notion tasks and meetings are found by the agent, saved, and only asked about when nothing or several are found; background runs never edit an unconfirmed page", () => {
  const read = (s: string) => readFileSync(join(skillsDir, s, "SKILL.md"), "utf8");
  const setup = read("setup");
  assert.match(setup, /Exactly one clear match/);
  assert.match(setup, /Several plausible matches/);
  assert.match(setup, /Nothing found/);
  for (const s of ["notion-tasks", "meeting-prep"]) {
    assert.match(read(s), /find it yourself and save it/, `${s}: discovers in chat`);
    assert.match(read(s), /(do not edit a page\s+nobody has confirmed|create no\s+pages)/, `${s}: no edits to an unconfirmed page when unattended`);
  }
});
