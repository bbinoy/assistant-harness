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
import { readFacts } from "./memory.ts";
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

async function report(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = readAudit((e) => isTriage(e) && e.ts > since);
  if (rows.length === 0) return console.log(`Nothing triaged in the last ${hours}h.`);
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

  for (const skill of ["daily-brief", "mailbird", "notion-tasks", "calendar", "meeting-prep"]) {
    line(existsSync(`${process.env.HOME}/.claude/skills/${skill}/SKILL.md`), `skill ${skill}`);
  }

  for (const [name, dir] of [["state", settings.stateDir], ["logs", settings.logsDir], ["memory", settings.memoryDir]] as const) {
    if (!existsSync(dir)) continue;
    const loose = readdirSync(dir).filter((f) => (statSync(`${dir}/${f}`).mode & 0o077) !== 0 && statSync(`${dir}/${f}`).isFile());
    line((statSync(dir).mode & 0o077) === 0, `${name}/ directory is owner-only`);
    line(loose.length === 0 ? true : "warn", `${name}/ files are owner-only`, loose.length ? `group/world-readable: ${loose.join(", ")}` : "");
  }
  line(true, "memory/facts.md", `${readFacts().length} fact(s) remembered`); // the count only, never the facts

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
