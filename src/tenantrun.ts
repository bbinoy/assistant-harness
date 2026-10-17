import { askTenant, prepareTenantChat } from "./agent.ts";
import { tenantOverBudget } from "./budget.ts";
import { cooldownUntil } from "./cooldown.ts";
import type { Conversation, RunHooks } from "./conversationmodel.ts";
import type { Picture } from "./image.ts";
import type { Document } from "./document.ts";
import type { KeyStore } from "./secrets.ts";
import { TenantKeyError } from "./errors.ts";
import { mayNotice, markDisclosed, setPaused, tenantById, tenantContext, wasDisclosed, type TenantContext } from "./tenants.ts";
import { DISCLOSURE, setupIncompleteReply } from "./tenantroute.ts";

// A tenant's turn, around the run itself (agent.ts askTenant): the gates that need no model, in code, in this order:
//   suspended or deleted since the message arrived -> nothing
//   her key is in a cooldown (a limit, no credit, refused) -> a fixed notice until it ends; nobody else is affected (cooldown.ts, per tenant)
//   her day's budget is spent -> a fixed notice until tomorrow
//   OpenBao cannot be reached, or holds no key for her -> "setup incomplete" / "try later"; the instance's own login is NEVER used instead
// and after the run: the AI disclosure in the first reply she ever gets (a fixed one, or the model's). A fixed notice is sent at most every
// TENANT_NOTICE_MINUTES; in between the turn stays silent ([[silent]]).

const SILENT = "[[silent]]";
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

export interface TenantRunnerDeps {
  keys: () => KeyStore;
  ask?: typeof askTenant;
  prepare?: typeof prepareTenantChat;
  now?: () => number;
}

export function createTenantRunner(deps: TenantRunnerDeps) {
  const now = deps.now ?? Date.now;
  const ask = deps.ask ?? askTenant;
  const prepare = deps.prepare ?? prepareTenantChat;

  // The first thing she is ever told starts with the disclosure, whoever wrote it.
  function disclose(ctx: TenantContext, text: string): string {
    if (wasDisclosed(ctx)) return text;
    markDisclosed(ctx);
    const body = text.trim() === SILENT ? "" : text;
    return body.startsWith(DISCLOSURE) ? body : `${DISCLOSURE}${body ? `\n\n${body}` : ""}`;
  }
  const notice = (ctx: TenantContext, kind: string, text: string) => ({ text: mayNotice(ctx, kind, now()) ? disclose(ctx, text) : SILENT });

  async function run(conv: Conversation, prompt: string, pictures?: Picture[], hooks?: RunHooks, documents?: Document[]): Promise<{ text: string; costUsd?: number }> {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    if (!rec || rec.status === "suspended") return { text: SILENT };
    const ctx = tenantContext(rec);
    const until = cooldownUntil(ctx.id, now());
    if (until) return notice(ctx, "cooldown", `Your Anthropic API key is paused (a usage limit, a billing problem or a refused request). I'll try again around ${hhmm(until)}; please check your Anthropic account if it persists.`);
    if (tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd)) return notice(ctx, "budget", `You've reached your daily limit of $${ctx.dailyBudgetUsd} on your own API key, so I'm resting until tomorrow.`);
    let apiKey: string | undefined;
    try {
      apiKey = await deps.keys().get(ctx.id);
    } catch (e) {
      console.error(`tenant ${ctx.id}: her API key could not be read:`, (e as Error).message);
      return notice(ctx, "store", "I can't reach my secret store right now, so I can't start. Please try again in a while.");
    }
    if (!apiKey) return notice(ctx, "setup", setupIncompleteReply());
    let r: Awaited<ReturnType<typeof ask>>;
    try {
      r = await ask(ctx, apiKey, prompt, pictures, hooks, documents);
    } catch (e) {
      if (e instanceof TenantKeyError) setPaused(ctx, cooldownUntil(ctx.id, now())); // for doctor, which is another process
      throw e;
    }
    setPaused(ctx, undefined);
    return { text: disclose(ctx, r.text), costUsd: r.costUsd };
  }

  // After her turn: a warm process for her next message, if her key can be read (never a reason to fail anything).
  function warm(conv: Conversation): void {
    const rec = conv.tenantId ? tenantById(conv.tenantId) : undefined;
    if (!rec || rec.status === "suspended") return;
    const ctx = tenantContext(rec);
    if (cooldownUntil(ctx.id, now()) || tenantOverBudget(ctx.costFile, ctx.dailyBudgetUsd)) return;
    try {
      void deps.keys().get(ctx.id).then((k) => k && prepare(ctx, k), () => {});
    } catch {
      /* OpenBao is not set up: no warm process, nothing else */
    }
  }

  return { run, warm };
}
