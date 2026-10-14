import { providerReady } from "@ted-personal-assistant/signal/tts";
import { voiceReady } from "@ted-personal-assistant/signal/voice";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spentToday } from "./budget.ts";
import { inQuietHours } from "./actions.ts";
import { Mailbird } from "./mailbird.ts";
import { isPaused, localTime } from "./pause.ts";
import { settings } from "./settings.ts";
import { disconnected, NAMES, readConnectors } from "./connectors.ts";
import { missingSetup, readNotes } from "./notes.ts";
import { dataPath, readJson, readText } from "./state.ts";

// `npm run doctor`: is everything this agent depends on in place? Prints no secrets.
export async function doctor() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  let bad = 0;
  const line = (ok: boolean | "warn", what: string, detail = "") => {
    if (ok === false) bad++;
    console.log(`${ok === true ? "ok  " : ok === "warn" ? "warn" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  };
  const run = (cmd: string, args: string[]) => {
    try { return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return undefined; }
  };

  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 24, "Node 24+ (runs TypeScript directly)", process.versions.node);

  const envPath = `${root}.env`;
  if (!existsSync(envPath)) line(false, ".env present");
  else {
    const mode = (statSync(envPath).mode & 0o777).toString(8);
    line(mode === "600", ".env is owner-only (600)", `mode ${mode}`);
    const env = await readFile(envPath, "utf8");
    line(/^SIGNAL_OWNER_NUMBER=\+\d+/m.test(env), "SIGNAL_OWNER_NUMBER set");
    line(!/^ANTHROPIC_API_KEY=./m.test(env) || process.env.HARNESS_AUTH === "api-key" ? true : "warn", "no API key shadowing the stored login", "API key lines override login mode only if HARNESS_AUTH=api-key");
  }

  line(true, "Signal channel", process.env.SIGNAL_ACCOUNT ? "the assistant's own account (its own chat)" : "Note to Self (optional: docs/SIGNAL-ACCOUNT.md gives the assistant its own account and name)");
  const sig = run("signal-cli", ["--version"]);
  line(!!sig, "signal-cli installed", sig);
  const accounts = await readFile(`${process.env.HOME}/.local/share/signal-cli/data/accounts.json`, "utf8").catch(() => "");
  line(/"number"/.test(accounts), "a Signal account is linked to signal-cli");
  const up = await new Promise<boolean>((res) => {
    const s = net.connect(settings.signalPort, settings.signalHost);
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
  line(up ? true : "warn", `Signal daemon reachable on ${settings.signalHost}:${settings.signalPort}`, up ? "" : "only running while the agent is");

  try {
    const mb = new Mailbird();
    await mb.connect();
    const inboxes = await mb.inboxes();
    line(true, "Mailbird MCP reachable", `${inboxes.length} inbox(es)`);
    await mb.close();
  } catch (e) {
    line(false, "Mailbird MCP reachable", (e as Error).message.slice(0, 80));
  }

  const auth = run("claude", ["auth", "status"]);
  line(!!auth && !/not logged in|logged out/i.test(auth), "Claude login valid (needed for Notion/Calendar/Gmail connectors)");

  const lc = run("launchctl", ["list", settings.launchdLabel]);
  line(lc ? (/"PID"/.test(lc) ? true : "warn") : false, `launchd job ${settings.launchdLabel} loaded and running`, lc ? "" : "not loaded");

  // The skills ship with the repo (plugin/skills), so there is nothing to install. What each
  // one still needs about the owner lives in memory notes, and the chat sets those up.
  for (const skill of ["daily-brief", "mailbird", "calendar", "notion-tasks", "meeting-prep", "setup"]) {
    line(existsSync(`${settings.pluginDir}/skills/${skill}/SKILL.md`), `skill ${skill} (bundled)`);
  }
  const conn = readConnectors();
  if (conn) {
    for (const k of ["notion", "calendar"] as const) line(conn[k] ? true : "warn", `${NAMES[k]} connector`, conn[k] ? "" : `not available in the last run (${localTime(conn.at)}): add it in your Claude account (Settings, Connectors)`);
  }
  const gaps = missingSetup(readNotes(), disconnected(conn));
  line(gaps.length === 0 ? true : "warn", "setup notes", gaps.length ? `not set up yet: ${gaps.join("; ")}. Message the assistant "set up".` : "calendars, tasks, meetings and writing voice are set up");

  for (const [name, dir] of [["state", settings.stateDir], ["logs", settings.logsDir], ["memory", settings.memoryDir]] as const) {
    if (!existsSync(dir)) continue;
    const loose = readdirSync(dir).filter((f) => (statSync(`${dir}/${f}`).mode & 0o077) !== 0 && statSync(`${dir}/${f}`).isFile());
    line((statSync(dir).mode & 0o077) === 0, `${name}/ directory is owner-only`);
    line(loose.length === 0 ? true : "warn", `${name}/ files are owner-only`, loose.length ? `group/world-readable: ${loose.join(", ")}` : "");
  }
  line(true, "memory/notes/", `${readNotes().length} active note(s)`); // the count only, never the notes

  const voice = voiceReady(settings.whisperModel);
  line(voice.ok ? true : "warn", "voice messages", voice.ok ? "transcribed locally with whisper.cpp" : `not available, missing: ${voice.missing.join("; ")}`);

  const tts = providerReady(settings.tts);
  const remote = settings.tts.provider !== "kokoro";
  const where = settings.tts.provider === "elevenlabs" ? "ElevenLabs (spoken text is sent to elevenlabs.io)" : settings.tts.provider === "http" ? `your own server at ${new URL(settings.tts.http.url).host} (spoken text is sent there)` : `local Kokoro, voice ${settings.ttsVoice}`;
  line(tts.ok || !settings.voiceReplies ? true : "warn", "spoken replies", !settings.voiceReplies ? "off (VOICE_REPLIES=off)" : tts.ok ? `${where}${remote ? `; fallback: ${settings.tts.fallback}` : ""}${process.env.SIGNAL_ACCOUNT ? "" : " (needs the assistant's own Signal account)"}` : `not set up, missing: ${tts.missing.join(", ")} (${remote ? "install ffmpeg" : "run scripts/setup-tts.sh"})`);

  const dream = readJson<{ lastRunAt?: string }>("state/dream.json", {});
  line(true, "nightly dream", settings.dream ? `once a day before the brief; last run ${dream.lastRunAt ? localTime(dream.lastRunAt) : "not yet"}` : "off (DREAM=off)");

  line(true, "proactive radar", settings.proactive ? `chosen by your chat's gate, about every ${settings.radarMinutes} min (its "[radar] ran" lines are in the log)` : "off (PROACTIVE=off)");

  const beat = readJson<{ lastTickAt?: string; lastNewMailAt?: string }>("state/heartbeat.json", {});
  const ageMin = beat.lastTickAt ? (Date.now() - Date.parse(beat.lastTickAt)) / 60_000 : Infinity;
  const quiet = inQuietHours(new Date(), settings.quietStartHour, settings.quietEndHour);
  line(
    ageMin <= 2 * settings.heartbeatMinutes + 1 || quiet ? true : "warn",
    "heartbeat is ticking",
    beat.lastTickAt ? `last tick ${Math.round(ageMin)} min ago${quiet ? ", night idle now" : ""}; last new mail ${beat.lastNewMailAt ? localTime(beat.lastNewMailAt) : "none yet"}` : "no tick recorded yet",
  );

  const spent = spentToday();
  line(spent < settings.dailyBudgetUsd, "daily spend guard", `$${spent.toFixed(2)} of $${settings.dailyBudgetUsd} today (notional)`);
  line(isPaused() ? "warn" : true, "not paused", isPaused() ? `${dataPath("state/paused")} exists` : "");
  const log = readText("logs/agent.log") ?? "";
  const hourAgo = new Date(Date.now() - 3600_000);
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const recentErrors = log.split("\n").filter((l) => l.includes(" ERR ") && l.slice(0, 5) >= hhmm(hourAgo)).length;
  line(recentErrors === 0 ? true : "warn", "no errors in the log in the last hour", recentErrors ? `${recentErrors} error line(s) in logs/agent.log` : "");

  console.log(bad === 0 ? "\nAll required checks passed." : `\n${bad} check(s) failed.`);
  process.exit(bad === 0 ? 0 : 1);
}
