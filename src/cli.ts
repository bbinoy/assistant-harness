import { isTriage, readAudit, type AuditEntry } from "./audit.ts";
import { triageCheck } from "./heartbeat.ts";
import { Mailbird } from "./mailbird.ts";
import { localTime } from "./pause.ts";
import { doctor } from "./doctor.ts";
import { settings } from "./settings.ts";
import { agreement } from "./autojudge.ts";
import { migrateLegacyLayout } from "./migrate.ts";

// Small operator tools:
//   npm run report [hours]        what the heartbeat archived / alerted / queued (default 24h)
//   npm run restore <id>          put an archived conversation back in the inbox
//   npm run doctor                is everything the agent depends on in place?
//   npm run triage-check [n]      how the heartbeat would classify the newest n emails (acts on nothing)

migrateLegacyLayout(settings.dataDir); // same one-time move as at agent start; a no-op once done

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
      console.log(`  ${localTime(e.ts)}  ${(e.meta?.from ?? "").slice(0, 28).padEnd(28)} ${(e.meta?.subject ?? "").slice(0, 60).padEnd(60)} [${e.meta?.kind}] ${decision === "archived" ? e.meta?.id : ""}`);
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

const [cmd, arg] = process.argv.slice(2);
if (!settings.mail && (cmd === "restore" || cmd === "triage-check")) {
  console.error(`${cmd} needs mail, and mail is off (MAIL_PROVIDER=none).`);
  process.exit(1);
}
if (cmd === "report") await report(Number(arg ?? 24));
else if (cmd === "restore" && arg) await restore(arg);
else if (cmd === "doctor") await doctor();
else if (cmd === "triage-check") {
  const rows = await triageCheck(new Mailbird(), Number(arg ?? 10));
  for (const r of rows) console.log(`${r.action.padEnd(8)} ${r.label.padEnd(10)} ${r.kind.padEnd(16)} ${r.from.slice(0, 24).padEnd(24)} ${r.subject.slice(0, 50).padEnd(50)} ${r.reason}`);
}
else console.log("usage: npm run report [hours] | npm run restore <conversationId> | npm run doctor | npm run triage-check [n]");
process.exit(0);
