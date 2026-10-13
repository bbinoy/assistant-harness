import { providerReady, voiceReady } from "@ted-personal-assistant/signal";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { isTriage, readAudit, type AuditEntry } from "./audit.ts";
import { spentToday } from "./budget.ts";
import { triageCheck } from "./heartbeat.ts";
import { inQuietHours } from "./actions.ts";
import { Mailbird } from "./mailbird.ts";
import { isPaused } from "./pause.ts";
import { settings } from "./settings.ts";
import { agreement } from "./autojudge.ts";
import { disconnected, NAMES, readConnectors } from "./connectors.ts";
import { missingSetup, readNotes } from "./notes.ts";
import { migrateLegacyLayout } from "./migrate.ts";
import { dataPath, readJson, readText } from "./state.ts";

// Small operator tools:
//   npm run report [hours]        what the heartbeat archived / alerted / queued (default 24h)
//   npm run restore <id>          put an archived conversation back in the inbox
//   npm run doctor                is everything the agent depends on in place?
//   npm run triage-check [n]      how the heartbeat would classify the newest n emails (acts on nothing)

migrateLegacyLayout(settings.dataDir); // same one-time move as at agent start; a no-op once done

// Local wall time, like the agent's own log.
const local = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// How the approval judge (src/autojudge.ts) did against the owner's own answers.
function judgeSummary(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = readAudit((e) => e.decision === "judge-vs-owner" && e.ts > since).map((e) => ({ judge: e.meta?.judge as "auto" | "ask", ownerApproved: Boolean(e.meta?.ownerApproved) }));
  if (rows.length === 0) return;
  const a = agreement(rows);
  console.log(`\nApproval judge (mode ${settings.autoApprove}), ${a.total} question(s) in the last ${hours}h:`);
  console.log(`  would have skipped the question: ${a.judgedAuto}, of which you approved ${a.autoOwnerApproved} and DECLINED ${a.autoOwnerDeclined}`);
  console.log(`  asked, and you approved anyway: ${a.judgedAskOwnerApproved}`);
}

async function report(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = readAudit((e) => isTriage(e) && e.ts > since);
  if (rows.length === 0) {
    console.log(`Nothing triaged in the last ${hours}h.`);
    return judgeSummary(hours);
  }
  const order = ["archived", "alerted", "covered-by-brief", "queued-for-handler", "archive-deferred", "archive-failed", "alert-failed", "handler-queue-failed", "kept"];
  const decisions = [...order, ...new Set(rows.map((e) => e.decision).filter((d) => !order.includes(d)))];
  for (const decision of decisions) {
    const set = rows.filter((e) => e.decision === decision);
    if (set.length === 0) continue;
    console.log(`\n${decision} (${set.length})`);
    for (const e of set) {
      console.log(`  ${local(e.ts)}  ${(e.meta?.from ?? "").slice(0, 28).padEnd(28)} ${(e.meta?.subject ?? "").slice(0, 60).padEnd(60)} [${e.meta?.kind}] ${decision === "archived" ? e.meta?.id : ""}`);
    }
  }
  judgeSummary(hours);
}

async function restore(id: string) {
  const mb = new Mailbird();
  await mb.connect();
  const entry: AuditEntry | undefined = readAudit((e) => isTriage(e) && e.meta?.id === id).pop();
  const candidates = [id, ...(String(entry?.meta?.result ?? "").match(UUID) ?? []).filter((u: string) => u !== id)];
  for (const c of candidates) {
    try {
      await mb.call("move_conversation_to_inbox", { conversationId: c });
      console.log(`Restored to the inbox (conversation ${c}).`);
      return process.exit(0);
    } catch {
      /* try the next candidate */
    }
  }
  // Last resort: find it in the archive by subject.
  if (entry?.meta?.subject) {
    const hits = await mb.call<{ conversationId: string; subject: string }[]>("search_conversations", { query: `subject:"${entry.meta.subject.replace(/"/g, "")}"`, limit: 5 });
    const hit = Array.isArray(hits) ? hits.find((h) => h.subject === entry.meta!.subject) : undefined;
    if (hit) {
      await mb.call("move_conversation_to_inbox", { conversationId: hit.conversationId });
      console.log(`Restored via subject search (conversation ${hit.conversationId}).`);
      return process.exit(0);
    }
  }
  console.error("Could not restore it automatically. Find it in Mailbird's archive by subject.");
  process.exit(1);
}

// `npm run doctor`: is everything this agent depends on in place? Prints no secrets.
async function doctor() {
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
    for (const k of ["notion", "calendar"] as const) line(conn[k] ? true : "warn", `${NAMES[k]} connector`, conn[k] ? "" : `not available in the last run (${local(conn.at)}): add it in your Claude account (Settings, Connectors)`);
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
  line(true, "nightly dream", settings.dream ? `once a day before the brief; last run ${dream.lastRunAt ? local(dream.lastRunAt) : "not yet"}` : "off (DREAM=off)");

  const radar = readJson<{ lastRunAt?: string; nextRunAt?: string; sent?: number }>("state/radar.json", {});
  line(true, "proactive radar", settings.proactive ? `adaptive, at most every ${settings.radarMinutes} min; last run ${radar.lastRunAt ? local(radar.lastRunAt) : "not yet"}${radar.nextRunAt ? `, next ${local(radar.nextRunAt)}` : ""}; ${radar.sent ?? 0} message(s) today` : "off (PROACTIVE=off)");

  const beat = readJson<{ lastTickAt?: string; lastNewMailAt?: string }>("state/heartbeat.json", {});
  const ageMin = beat.lastTickAt ? (Date.now() - Date.parse(beat.lastTickAt)) / 60_000 : Infinity;
  const quiet = inQuietHours(new Date(), settings.quietStartHour, settings.quietEndHour);
  line(
    ageMin <= 2 * settings.heartbeatMinutes + 1 || quiet ? true : "warn",
    "heartbeat is ticking",
    beat.lastTickAt ? `last tick ${Math.round(ageMin)} min ago${quiet ? ", night idle now" : ""}; last new mail ${beat.lastNewMailAt ? local(beat.lastNewMailAt) : "none yet"}` : "no tick recorded yet",
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

const [cmd, arg] = process.argv.slice(2);
if (cmd === "report") await report(Number(arg ?? 24));
else if (cmd === "restore" && arg) await restore(arg);
else if (cmd === "doctor") await doctor();
else if (cmd === "triage-check") {
  const rows = await triageCheck(new Mailbird(), Number(arg ?? 10));
  for (const r of rows) console.log(`${r.action.padEnd(8)} ${r.label.padEnd(10)} ${r.kind.padEnd(16)} ${r.from.slice(0, 24).padEnd(24)} ${r.subject.slice(0, 50).padEnd(50)} ${r.reason}`);
}
else console.log("usage: npm run report [hours] | npm run restore <conversationId> | npm run doctor | npm run triage-check [n]");
process.exit(0);
