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

type Line = (ok: boolean | "warn", what: string, detail?: string) => void;

// The mail check. MAIL_PROVIDER=none is a valid setup, not a failure: nothing is connected and nothing is expected.
export async function mailCheck(line: Line, mail: boolean, connect: () => Promise<number>): Promise<void> {
  if (!mail) return line(true, "mail: off", "MAIL_PROVIDER=none, chat only");
  try {
    line(true, "Mailbird MCP reachable", `${await connect()} inbox(es)`);
  } catch (e) {
    line(false, "Mailbird MCP reachable", (e as Error).message.slice(0, 80));
  }
}

// The Gmail checks (MAIL_PROVIDER=gmail): the owner's own address is set, the claude.ai connector was available in the last run, and which archive mode is on.
// The connector comes with the Claude login; whether it is there is only known from a run's start-up message (connectors.ts), so before the first run it is a warning.
export function gmailChecks(line: Line, o: { self: string | undefined; connector: boolean | undefined; archiveLive: boolean; briefEmail: boolean }): void {
  line(!!o.self, "MAIL_SELF_ADDRESS set", o.self ? "" : "your own Gmail address, the only address the brief may be emailed to (.env.example)");
  line(o.connector === undefined ? "warn" : o.connector, "Gmail connector available", o.connector === undefined ? "no run yet: start the agent, then run doctor again" : o.connector ? "" : "not available in the last run: connect Gmail in your Claude account (Settings, Connectors)");
  line(true, "Gmail archiving", o.archiveLive ? "live (GMAIL_ARCHIVE_LIVE=true)" : "LOG-ONLY (GMAIL_ARCHIVE_LIVE=false): it records would-archive and archives nothing; set true after the trial week");
  line(o.briefEmail && !o.self ? false : true, "brief by email", o.briefEmail ? "on: emailed to MAIL_SELF_ADDRESS only, plus the Signal summary" : "off (BRIEF_EMAIL=off): the brief goes to Signal only");
}

// The skills that must ship with the repo for the configured setup.
export const requiredSkills = (mail: boolean, provider: string = settings.mailProvider): string[] => ["daily-brief", ...(mail ? [provider === "gmail" ? "gmail" : "mailbird"] : []), "calendar", "notion-tasks", "meeting-prep", "setup"];

// What the heartbeat line says after "last tick": mail is only mentioned when there is mail.
export const heartbeatDetail = (beat: { lastTickAt?: string; lastNewMailAt?: string }, ageMin: number, quiet: boolean, mail: boolean, localTime: (iso: string) => string): string =>
  beat.lastTickAt ? `last tick ${Math.round(ageMin)} min ago${quiet ? ", night idle now" : ""}${mail ? `; last new mail ${beat.lastNewMailAt ? localTime(beat.lastNewMailAt) : "none yet"}` : "; mail off"}` : "no tick recorded yet";

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

  if (settings.mailProvider === "gmail") gmailChecks(line, { self: settings.mailSelfAddress, connector: readConnectors()?.gmail, archiveLive: settings.gmailArchiveLive, briefEmail: settings.briefEmail });
  else await mailCheck(line, settings.mail, async () => {
    const mb = new Mailbird();
    try {
      await mb.connect();
      return (await mb.inboxes()).length;
    } finally {
      await mb.close().catch(() => {});
    }
  });

  const auth = run("claude", ["auth", "status"]);
  line(!!auth && !/not logged in|logged out/i.test(auth), "Claude login valid (needed for Notion/Calendar/Gmail connectors)");

  const lc = run("launchctl", ["list", settings.launchdLabel]);
  line(lc ? (/"PID"/.test(lc) ? true : "warn") : false, `launchd job ${settings.launchdLabel} loaded and running`, lc ? "" : "not loaded");

  // The skills ship with the repo (plugin/skills), so there is nothing to install. What each
  // one still needs about the owner lives in memory notes, and the chat sets those up.
  for (const skill of requiredSkills(settings.mail)) {
    line(existsSync(`${settings.pluginDir}/skills/${skill}/SKILL.md`), `skill ${skill} (bundled)`);
  }
  const conn = readConnectors();
  if (conn) {
    for (const k of ["notion", "calendar"] as const) line(conn[k] ? true : "warn", `${NAMES[k]} connector`, conn[k] ? "" : `not available in the last run (${localTime(conn.at)}): add it in your Claude account (Settings, Connectors)`);
  }
  const gaps = missingSetup(readNotes(), disconnected(conn), settings.mail);
  line(gaps.length === 0 ? true : "warn", "setup notes", gaps.length ? `not set up yet: ${gaps.join("; ")}. Message the assistant "set up".` : settings.mail ? "calendars, tasks, meetings and writing voice are set up" : "calendars, tasks and meetings are set up");

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
    heartbeatDetail(beat, ageMin, quiet, settings.mail, localTime),
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
