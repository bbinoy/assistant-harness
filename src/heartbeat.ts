import { formatAlert, inQuietHours, planActions } from "./actions.ts";
import { audit } from "./audit.ts";
import type { HandleItem } from "./handler.ts";
import { Mailbird } from "./mailbird.ts";
import { isPaused } from "./pause.ts";
import { settings } from "./settings.ts";
import { readJson, writeJson } from "./state.ts";
import { triageBatch, type MailInput } from "./triage.ts";

// The heartbeat: every few minutes (not at night), list the inboxes with NO model call.
// Only when something new arrived does a model classify it (one batch), and then the
// pure rules in actions.ts decide what to archive, alert on or hand to the handler.

const SEEN = "state/seen.json";
const LIVENESS = "state/heartbeat.json"; // last tick, for `npm run doctor`
const SEEN_TTL_MS = 14 * 24 * 3600_000;
export const BRIEF_SUBJECT = /^\s*[☀🌙]/u; // our own briefs: never triaged
const FETCH_CONCURRENCY = 4;

interface Seen {
  seededAt?: string;
  keys: Record<string, number>; // "conversationId:lastMessageId" -> first seen (epoch ms)
}

interface Row {
  conversationId: string;
  subject: string;
  lastSender: string;
  receivedAtUtc: string; // despite the name, Mailbird reports local time (only used for ordering)
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

export interface HeartbeatHooks {
  alert: (text: string) => Promise<void>; // tell the owner something (plain text)
  handle: (items: HandleItem[]) => void; // queue mail for the handler
  briefDue: () => boolean; // today's brief is still due: it will report urgent mail itself
  onTick: () => void; // tick-driven jobs (wake-ups, dream, brief, radar): independent of the mail check, never awaited
}

const seenKey = (m: { conversationId: string; lastMessageId?: number; messageId?: number }) =>
  `${m.conversationId}:${m.lastMessageId ?? m.messageId}`;

// The cheap pre-check. Returns conversations whose latest message is new, plus older copies
// of our own brief to tidy away. Nothing is marked seen until the caller commits.
async function checkMail(mb: Mailbird) {
  const seen = readJson<Seen>(SEEN, { keys: {} });
  const seeding = !seen.seededAt; // first run ever: record a baseline, triage nothing
  const now = Date.now();
  const fresh: NewMail[] = [];
  const staleBriefs: string[] = [];

  for (const inbox of await mb.inboxes()) {
    const rows = await mb.call<Row[]>("list_conversations", { folderId: inbox.folderId, limit: 100 });
    // Keep only the newest of our own briefs. "Own" = brief subject AND this account's own name.
    const own = rows
      .filter((r) => BRIEF_SUBJECT.test(r.subject) && r.lastSender === inbox.senderName)
      .sort((a, b) => b.receivedAtUtc.localeCompare(a.receivedAtUtc));
    staleBriefs.push(...own.slice(1).map((r) => r.conversationId));

    for (const row of rows) {
      const key = seenKey(row);
      if (seen.keys[key]) continue;
      seen.keys[key] = now;
      if (seeding || BRIEF_SUBJECT.test(row.subject)) continue;
      fresh.push({
        accountEmail: inbox.email,
        conversationId: row.conversationId,
        messageId: row.lastMessageId,
        from: row.lastSender,
        subject: row.subject,
        receivedAtUtc: row.receivedAtUtc,
      });
    }
  }
  for (const [key, ts] of Object.entries(seen.keys)) if (now - ts > SEEN_TTL_MS) delete seen.keys[key];
  if (seeding) seen.seededAt = new Date().toISOString();

  return {
    fresh,
    staleBriefs,
    seeding,
    // Mail we chose not to finish with (archive cap reached) stays unseen: the next tick retries it.
    unsee: (m: NewMail) => void delete seen.keys[seenKey(m)],
    commit: () => writeJson(SEEN, seen),
  };
}

// Runs `fn` over `items` with at most `limit` in flight, keeping order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const short = (res: unknown) => String(typeof res === "string" ? res : JSON.stringify(res)).replace(/\s+/g, " ").slice(0, 120);

async function fetchInputs(mb: Mailbird, mails: NewMail[]): Promise<MailInput[]> {
  return mapLimit(mails, FETCH_CONCURRENCY, async (m): Promise<MailInput> => {
    const msg = await mb.call<{ body?: string; from?: { displayName?: string; email?: string } }>("get_message", { messageId: m.messageId });
    return {
      account: m.accountEmail,
      fromName: msg.from?.displayName ?? m.from,
      fromEmail: msg.from?.email ?? "",
      subject: m.subject,
      receivedAtUtc: m.receivedAtUtc,
      body: msg.body ?? "",
    };
  });
}

// Classify all new mail in one batch, act on the plan, record every decision.
// Returns mail that should be retried next tick. Once the batch is classified nothing here
// throws: every side effect is guarded, so a failure can never cause a repeat alert.
async function processNewMail(mb: Mailbird, fresh: NewMail[], hooks: HeartbeatHooks): Promise<NewMail[]> {
  console.log(`heartbeat: ${fresh.length} new conversation(s)`);

  const results = await triageBatch(await fetchInputs(mb, fresh));
  const plan = planActions(results, { maxArchives: settings.maxArchivesPerTick });
  const decision: string[] = results.map((t) => (settings.heartbeatLive ? "kept" : `would-${t.label}`));
  const extra: Record<number, Record<string, unknown>> = {};

  if (settings.heartbeatLive) {
    for (const i of plan.archive) {
      try {
        // Mailbird may assign a new id on archive: the response is kept so `npm run restore` can find it.
        extra[i] = { result: short(await mb.call("archive_conversation", { conversationId: fresh[i]!.conversationId })) };
        decision[i] = "archived";
      } catch (e) {
        decision[i] = "archive-failed";
        extra[i] = { error: (e as Error).message.slice(0, 100) };
      }
    }
    for (const i of plan.deferred) decision[i] = "archive-deferred";

    // act_now: ONE batched message per tick. While today's brief is still due (e.g. the first
    // tick after the night), the brief reports these itself, so no separate alert is sent.
    if (plan.alert.length > 0) {
      if (hooks.briefDue()) {
        for (const i of plan.alert) decision[i] = "covered-by-brief";
      } else {
        const ok = await hooks
          .alert(formatAlert(plan.alert.map((i) => ({ from: fresh[i]!.from, subject: fresh[i]!.subject, reason: results[i]!.reason }))))
          .then(() => true, (e) => (console.error("heartbeat: alert failed:", (e as Error).message), false));
        for (const i of plan.alert) decision[i] = ok ? "alerted" : "alert-failed";
      }
    }

    if (plan.handle.length > 0) {
      try {
        hooks.handle(
          plan.handle.map((i) => {
            const m = fresh[i]!;
            return { account: m.accountEmail, conversationId: m.conversationId, messageId: m.messageId, from: m.from, subject: m.subject };
          }),
        );
        for (const i of plan.handle) decision[i] = "queued-for-handler";
      } catch (e) {
        console.error("heartbeat: could not queue for the handler:", (e as Error).message);
        for (const i of plan.handle) decision[i] = "handler-queue-failed";
      }
    }
  }

  const counts: Record<string, number> = {};
  fresh.forEach((m, i) => {
    const t = results[i]!;
    counts[decision[i]!] = (counts[decision[i]!] ?? 0) + 1;
    audit("heartbeat_triage", decision[i]!, "heartbeat", {
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
  });
  console.log(`heartbeat: triaged ${fresh.length} (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`);
  return plan.deferred.map((i) => fresh[i]!);
}

// Older copies of our own brief: archived, keeping the newest one per account.
async function archiveStaleBriefs(mb: Mailbird, ids: string[]) {
  for (const id of ids.slice(0, 5)) {
    try {
      await mb.call("archive_conversation", { conversationId: id });
      audit("heartbeat_stale_brief", "archived", "heartbeat", { id });
    } catch (e) {
      console.error("heartbeat: could not archive an old brief:", (e as Error).message);
    }
  }
}

export function startHeartbeat(hooks: HeartbeatHooks) {
  const mb = new Mailbird();
  let running = false;
  let failing = false;

  // The mail check is one job. Wake-ups, the dream, the brief and the radar (hooks.onTick, main.ts) are others: every
  // timer fire starts them all, none waits for or depends on another, and a failing or hanging mail check (Mailbird
  // down, a slow handler) never skips them. Each has its own re-entrancy guard.
  const mailCheck = async () => {
    if (running || isPaused()) return; // mail ticks never overlap
    // Night: no mail work at all (no Mailbird calls, no model turns). Everything that arrived
    // is picked up together by the first tick after quietEndHour.
    if (inQuietHours(new Date(), settings.quietStartHour, settings.quietEndHour)) return;
    running = true;
    try {
      const mail = await checkMail(mb);
      failing = false;
      if (mail.seeding) {
        console.log("heartbeat: baseline recorded, existing inbox treated as seen");
      } else {
        if (mail.fresh.length > 0) for (const m of await processNewMail(mb, mail.fresh, hooks)) mail.unsee(m);
        if (settings.heartbeatLive && mail.staleBriefs.length > 0) await archiveStaleBriefs(mb, mail.staleBriefs);
      }
      mail.commit(); // only now are these messages "seen"
      const prev = readJson<{ lastNewMailAt?: string }>(LIVENESS, {});
      writeJson(LIVENESS, { lastTickAt: new Date().toISOString(), lastNewMailAt: mail.fresh.length ? new Date().toISOString() : prev.lastNewMailAt });
    } catch (e) {
      if (!failing) console.error("heartbeat error:", (e as Error).message); // once per outage
      failing = true;
      await mb.close().catch(() => {}); // reconnect on the next tick
    } finally {
      running = false;
    }
  };
  const tick = () => {
    try {
      hooks.onTick(); // starts its jobs without waiting for them
    } catch (e) {
      console.error("heartbeat: tick jobs failed to start:", (e as Error).message);
    }
    void mailCheck().catch((e) => console.error("heartbeat: mail check failed:", (e as Error).message));
  };

  setTimeout(tick, 20_000); // first tick shortly after start
  setInterval(tick, settings.heartbeatMinutes * 60_000);
  console.log(
    `heartbeat: every ${settings.heartbeatMinutes} min, idle ${settings.quietStartHour}:00-${settings.quietEndHour}:00, actions ${settings.heartbeatLive ? "LIVE" : "log-only"}`,
  );
}

// `npm run triage-check`: classify the newest inbox mail exactly as the heartbeat would, and
// show what it would do. Acts on nothing, writes nothing: a safe way to check the classifier.
export async function triageCheck(mb: Mailbird, count: number) {
  const mails: NewMail[] = [];
  for (const inbox of await mb.inboxes()) {
    const rows = await mb.call<Row[]>("list_conversations", { folderId: inbox.folderId, limit: count });
    for (const r of rows) {
      if (BRIEF_SUBJECT.test(r.subject)) continue;
      mails.push({ accountEmail: inbox.email, conversationId: r.conversationId, messageId: r.lastMessageId, from: r.lastSender, subject: r.subject, receivedAtUtc: r.receivedAtUtc });
    }
  }
  mails.sort((a, b) => b.receivedAtUtc.localeCompare(a.receivedAtUtc)).splice(count);
  const results = await triageBatch(await fetchInputs(mb, mails));
  const plan = planActions(results, { maxArchives: settings.maxArchivesPerTick });
  const action = (i: number) =>
    plan.archive.includes(i) ? "archive" : plan.alert.includes(i) ? "alert" : plan.handle.includes(i) ? "handler" : plan.deferred.includes(i) ? "defer" : "keep";
  return mails.map((m, i) => ({ ...m, ...results[i]!, action: action(i) }));
}
