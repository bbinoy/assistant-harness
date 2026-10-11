import { mkdir, readFile, writeFile } from "node:fs/promises";
import { audit } from "./audit.ts";
import { formatAlert, inQuietHours, planActions } from "./actions.ts";
import type { HandleItem } from "./handler.ts";
import { Mailbird } from "./mailbird.ts";
import { isPaused } from "./pause.ts";
import { triageBatch, type MailInput } from "./triage.ts";

const TICK_MS = Number(process.env.HEARTBEAT_MINUTES ?? 15) * 60_000;
const SEEN_FILE = new URL("../state/seen.json", import.meta.url);
const KEEP_MS = 14 * 24 * 3600_000;
// "live" = archive/alert/hand off for real; "log" = only record what it would do.
const ACTIONS_LIVE = (process.env.HEARTBEAT_ACTIONS ?? "live") === "live";
const MAX_ARCHIVES_PER_TICK = Number(process.env.HEARTBEAT_MAX_ARCHIVES ?? 25);
const QUIET_START = Number(process.env.QUIET_START_HOUR ?? 22);
const QUIET_END = Number(process.env.QUIET_END_HOUR ?? 7);
const BRIEF_SUBJECT = /^\s*[☀🌙]/u; // our own briefs are never triaged

interface Seen {
  seededAt?: string;
  keys: Record<string, number>; // "conversationId:lastMessageId" -> first seen (epoch ms)
}

export interface StaleBrief {
  conversationId: string;
  accountEmail: string;
}

interface Row {
  conversationId: string;
  subject: string;
  lastSender: string;
  receivedAtUtc: string;
  isRead: boolean;
  lastMessageId: number;
}

export interface NewMail {
  accountEmail: string;
  conversationId: string;
  messageId: number;
  from: string;
  subject: string;
  receivedAtUtc: string;
}

async function loadSeen(): Promise<Seen> {
  try {
    return JSON.parse(await readFile(SEEN_FILE, "utf8"));
  } catch {
    return { keys: {} };
  }
}

async function saveSeen(seen: Seen) {
  await mkdir(new URL("../state/", import.meta.url), { recursive: true });
  await writeFile(SEEN_FILE, JSON.stringify(seen));
}

// The cheap pre-check: no model involved. Lists each inbox and returns only
// conversations whose latest message we have not seen before.
export async function checkMail(mb: Mailbird): Promise<{ fresh: NewMail[]; stale: StaleBrief[]; seeded: boolean; commit: () => Promise<void>; unsee: (m: NewMail) => void }> {
  const seen = await loadSeen();
  const seeding = !seen.seededAt;
  const fresh: NewMail[] = [];
  const stale: StaleBrief[] = [];
  const now = Date.now();

  const accounts = await mb.call<{ id: number; email: string; senderName: string }[]>("list_accounts");
  for (const account of accounts) {
    const folders = await mb.call<{ id: number; identity: string }[]>("list_folders", { accountId: account.id });
    const inbox = folders.find((f) => f.identity === "Inbox");
    if (!inbox) continue;
    const rows = await mb.call<Row[]>("list_conversations", { folderId: inbox.id, limit: 100 });
    // Our own briefs pile up in the inbox. Keep only the newest per account; the rest are
    // archived by the caller. "Own" = brief subject AND sent by this account's own name.
    const own = rows
      .filter((r) => BRIEF_SUBJECT.test(r.subject) && r.lastSender === account.senderName)
      .sort((a, b) => b.receivedAtUtc.localeCompare(a.receivedAtUtc));
    for (const old of own.slice(1)) stale.push({ conversationId: old.conversationId, accountEmail: account.email });
    for (const row of rows) {
      const key = `${row.conversationId}:${row.lastMessageId}`;
      if (seen.keys[key]) continue;
      seen.keys[key] = now;
      if (seeding || BRIEF_SUBJECT.test(row.subject)) continue;
      fresh.push({
        accountEmail: account.email,
        conversationId: row.conversationId,
        messageId: row.lastMessageId,
        from: row.lastSender,
        subject: row.subject,
        receivedAtUtc: row.receivedAtUtc,
      });
    }
  }
  for (const [key, ts] of Object.entries(seen.keys)) if (now - ts > KEEP_MS) delete seen.keys[key];
  if (seeding) seen.seededAt = new Date().toISOString();
  // The seen-list is only written once the caller has finished with `fresh`. If triage
  // fails halfway, nothing is committed and the same mail is retried on the next tick.
  return {
    fresh,
    stale,
    seeded: seeding,
    commit: () => saveSeen(seen),
    // Mail we chose not to finish with (e.g. archive cap reached) stays unseen, so the next tick retries it.
    unsee: (m) => void delete seen.keys[`${m.conversationId}:${m.messageId}`],
  };
}

export interface HeartbeatHooks {
  onTick?: (mb: Mailbird) => void; // tick-driven work, e.g. the daily brief
  alert: (text: string) => Promise<void>; // tell the owner something (plain text)
  handle: (items: HandleItem[]) => Promise<void>; // hand mail to the Sonnet handler
  briefDue: () => Promise<boolean>; // true while today's daily brief has not been delivered yet
}

const brief = (res: unknown) => String(typeof res === "string" ? res : JSON.stringify(res)).replace(/\s+/g, " ").slice(0, 120);

// Fetch bodies, classify all new mail in one batch, act on the plan, record every decision.
export async function processNewMail(mb: Mailbird, fresh: NewMail[], hooks: HeartbeatHooks): Promise<NewMail[]> {
  console.log(`heartbeat: ${fresh.length} new conversation(s)`);

  // Bodies are needed for classification. One fetch per new message, no model involved.
  const inputs: MailInput[] = [];
  for (const m of fresh) {
    const msg = await mb.call<{ body?: string; from?: { displayName?: string; email?: string } }>("get_message", { messageId: m.messageId });
    inputs.push({
      account: m.accountEmail,
      fromName: msg.from?.displayName ?? m.from,
      fromEmail: msg.from?.email ?? "",
      subject: m.subject,
      receivedAtUtc: m.receivedAtUtc,
      body: msg.body ?? "",
    });
  }

  const results = await triageBatch(inputs);
  const plan = planActions(results, { maxArchives: MAX_ARCHIVES_PER_TICK });
  const decision: string[] = results.map(() => "kept");
  const extra: Record<number, Record<string, unknown>> = {};

  if (!ACTIONS_LIVE) {
    results.forEach((t, i) => (decision[i] = `would-${t.label}`));
  } else {
    for (const i of plan.archive) {
      try {
        const res = await mb.call("archive_conversation", { conversationId: fresh[i]!.conversationId });
        decision[i] = "archived";
        extra[i] = { result: brief(res) }; // Mailbird may assign a new id on archive: kept so it can be restored
      } catch (e) {
        decision[i] = "archive-failed";
        extra[i] = { error: (e as Error).message.slice(0, 100) };
      }
    }
    for (const i of plan.deferred) decision[i] = "archive-deferred";

    // act_now: ONE batched message per tick. While today's brief is still due (e.g. the first
    // tick after the night), the brief reports these itself, so no separate alert is sent.
    if (plan.alert.length > 0) {
      if (await hooks.briefDue()) {
        for (const i of plan.alert) decision[i] = "covered-by-brief";
      } else {
        try {
          await hooks.alert(formatAlert(plan.alert.map((i) => ({ from: fresh[i]!.from, subject: fresh[i]!.subject, reason: results[i]!.reason }))));
          for (const i of plan.alert) decision[i] = "alerted";
        } catch (e) {
          for (const i of plan.alert) decision[i] = "alert-failed";
          console.error("heartbeat: alert failed:", (e as Error).message);
        }
      }
    }

    if (plan.handle.length > 0) {
      await hooks.handle(
        plan.handle.map((i) => ({
          account: fresh[i]!.accountEmail,
          conversationId: fresh[i]!.conversationId,
          messageId: fresh[i]!.messageId,
          from: fresh[i]!.from,
          subject: fresh[i]!.subject,
        })),
      );
      for (const i of plan.handle) decision[i] = "queued-for-handler";
    }
  }

  const counts: Record<string, number> = {};
  for (let i = 0; i < fresh.length; i++) {
    const m = fresh[i]!;
    const t = results[i]!;
    counts[decision[i]!] = (counts[decision[i]!] ?? 0) + 1;
    await audit("heartbeat_triage", decision[i]!, "heartbeat", {
      id: m.conversationId,
      messageId: m.messageId,
      from: m.from,
      subject: m.subject,
      account: m.accountEmail,
      label: t.label,
      kind: t.kind,
      reason: t.reason,
      protected: t.protected,
      ...extra[i],
    });
  }
  console.log(`heartbeat: triaged ${fresh.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})${ACTIONS_LIVE ? "" : " [log-only]"}`);
  return plan.deferred.map((i) => fresh[i]!);
}

// Older copies of our own briefs: archive, keeping the newest one per account.
async function archiveStaleBriefs(mb: Mailbird, stale: StaleBrief[]) {
  for (const s of stale.slice(0, 5)) {
    try {
      await mb.call("archive_conversation", { conversationId: s.conversationId });
      await audit("heartbeat_stale_brief", "archived", "heartbeat", { id: s.conversationId, account: s.accountEmail });
    } catch (e) {
      console.error("heartbeat: could not archive an old brief:", (e as Error).message);
    }
  }
}

export function startHeartbeat(hooks: HeartbeatHooks) {
  const mb = new Mailbird();
  let running = false;
  let failing = false;

  const tick = async () => {
    if (running) return; // never overlap ticks
    if (isPaused()) return;
    // Night: no mail work at all (no Mailbird calls, no haiku turns). Everything that arrives
    // is picked up together by the first tick after QUIET_END. Only the daily brief may still
    // fire (a Mac that wakes late still gets that day's brief).
    if (inQuietHours(new Date(), QUIET_START, QUIET_END)) {
      hooks.onTick?.(mb);
      return;
    }
    running = true;
    let reachable = false;
    try {
      const { fresh, stale, seeded, commit, unsee } = await checkMail(mb);
      reachable = true; // Mailbird answered
      failing = false;
      if (seeded) {
        console.log("heartbeat: baseline recorded, existing inbox treated as seen");
      } else {
        if (fresh.length > 0) for (const m of await processNewMail(mb, fresh, hooks)) unsee(m);
        if (ACTIONS_LIVE && stale.length > 0) await archiveStaleBriefs(mb, stale);
      }
      await commit(); // only now are these messages "seen"
    } catch (e) {
      if (!failing) console.error("heartbeat error:", (e as Error).message); // log once per outage
      failing = true;
      await mb.close().catch(() => {}); // reconnect on the next tick
    } finally {
      running = false;
    }
    // Tick-driven work (the daily brief) runs whenever Mailbird is reachable, even on quiet ticks.
    if (reachable && !failing) hooks.onTick?.(mb);
  };

  setTimeout(tick, 20_000); // first tick shortly after start
  setInterval(tick, TICK_MS);
  console.log(`heartbeat: every ${TICK_MS / 60_000} min, idle ${QUIET_START}:00-${QUIET_END}:00, actions ${ACTIONS_LIVE ? "LIVE" : "log-only"}`);
}
