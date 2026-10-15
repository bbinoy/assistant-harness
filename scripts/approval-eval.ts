// Measures how replies to open approvals are read, strict against soft against conversational, with REAL Haiku calls.
//   HARNESS_DATA_DIR=$(mktemp -d) node --conditions=workspace-source scripts/approval-eval.ts [out.json] [passes]
// passes: comma list of style:temperature, e.g. strict:cold,soft:warm,conversational:warm (default: all five).
// It drives the real approvals.ts (request + answer) in-process, nothing is sent anywhere. Costs a few cents. Not part of npm test.
import { writeFileSync } from "node:fs";
import { answer, answerReaction, request } from "../src/approvals.ts";
import { discardJudge, prepareJudge } from "../src/approvaljudge.ts";
import { spentToday } from "../src/budget.ts";
import { describeCall } from "../src/format.ts";
import { settings } from "../src/settings.ts";
import { composeQuestion } from "../src/softjudge.ts";
import { ASKS, CORPUS, SCENARIOS, type Case } from "./approval-corpus.ts";

type Style = "strict" | "soft" | "conversational";
const mutable = settings as { approvalStyle: Style; warm: boolean };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextTs = 1_000_000;

interface Row {
  id: number;
  tag: string;
  text: string;
  scenario: string;
  outcome: string;
  resolved: string; // which approval was resolved and how, or "-"
  result: "correct" | "FALSE_APPROVAL" | "false_decline" | "over_clarify" | "missed" | "hijacked_chat" | "safe_other";
  ms: number;
  reply?: string;
}

// The question text per ask: the code text, or (conversational) a model-written, checked one, composed once per ask.
const written = new Map<string, string>();
async function questionFor(key: string, style: Style, recent: Case["scenario"]): Promise<string | undefined> {
  if (style !== "conversational") return undefined;
  const hit = written.get(key);
  if (hit) return hit;
  const a = ASKS[key]!;
  const c = await composeQuestion({ tool: a.tool, args: a.input, details: describeCall(a.tool, a.input), recent: SCENARIOS[recent]!.recent, background: !!a.background, source: a.background ? "background" : "chat" });
  if (!c.text) throw new Error(`no question for ${key}: ${c.failure}`);
  written.set(key, c.text);
  return c.text;
}

async function runCase(c: Case, style: Style, warm: boolean): Promise<Row> {
  mutable.approvalStyle = style;
  mutable.warm = warm;
  const sc = SCENARIOS[c.scenario]!;
  const sent: Record<string, number> = {};
  const decisions: Record<string, { approved: boolean; feedback?: string; updatedInput?: Record<string, unknown> } | undefined> = {};
  const real = Date.now;
  const pending: Promise<unknown>[] = [];
  let closedTs = 0;
  if (sc.closedOld) {
    closedTs = nextTs++;
    const old = request(async () => closedTs, "Change calendar event\nOld standup", { tool: ASKS.oldCal!.tool, input: ASKS.oldCal!.input }, undefined, {});
    await sleep(5);
    answerReaction("👎", closedTs);
    await old;
  }
  for (const key of sc.open) {
    const a = ASKS[key]!;
    const ts = nextTs++;
    sent[key] = ts;
    Date.now = () => real() - a.minutesAgo * 60_000; // the ask looks that old to the judge
    const q = await questionFor(key, style, c.scenario);
    pending.push(request(async () => ts, describeCall(a.tool, a.input), { tool: a.tool, input: structuredClone(a.input) }, undefined, { background: !!a.background, question: q }).then((d) => (decisions[key] = d)));
    Date.now = real;
  }
  await sleep(5);
  if (warm) {
    prepareJudge();
    await sleep(7000); // let the spare start
  } else discardJudge();
  const quote = c.quote === "closed" ? { timestamp: closedTs } : c.quote ? { timestamp: sent[c.quote]! } : undefined;
  const t0 = real();
  const a = await answer(c.text, () => {}, quote, { recent: () => sc.recent });
  const ms = real() - t0;
  await sleep(5);
  const resolved = sc.open.filter((k) => decisions[k]);
  const first = resolved[0];
  const d = first ? decisions[first] : undefined;
  const e = c.expect;
  const approvedKeys = resolved.filter((k) => decisions[k]!.approved);
  let result: Row["result"];
  if (e.kind === "approveAll" || e.kind === "mixed") {
    const wantYes = e.kind === "approveAll" ? e.targets : e.approve;
    const wantNo = e.kind === "approveAll" ? [] : e.decline;
    const wrong = approvedKeys.some((k) => !wantYes.includes(k));
    result = wrong ? "FALSE_APPROVAL" : wantYes.every((k) => approvedKeys.includes(k)) && wantNo.every((k) => decisions[k] && !decisions[k]!.approved) ? "correct" : "over_clarify";
  } else if (approvedKeys.length) {
    const ok = (e.kind === "approve" && approvedKeys.length === 1 && approvedKeys[0] === e.target) || (e.kind === "modify" && approvedKeys.length === 1 && approvedKeys[0] === e.target && String(decisions[e.target]!.updatedInput?.[e.field] ?? "").includes(e.contains));
    result = ok ? "correct" : "FALSE_APPROVAL";
  } else if (resolved.length) {
    const declinedOnly = resolved.length === 1 ? resolved[0] : "";
    if (e.kind === "decline") result = declinedOnly === e.target ? "correct" : "safe_other";
    else if (e.kind === "approve" || e.kind === "modify") result = "false_decline";
    else if (e.kind === "chat") result = "hijacked_chat";
    else result = "safe_other"; // a decline (with the words as feedback) of something that was not an approval: safe
  } else if (a.outcome === "clarify") {
    result = e.kind === "approve" || e.kind === "modify" || e.kind === "decline" ? "over_clarify" : e.kind === "chat" ? "hijacked_chat" : "correct";
  } else {
    result = e.kind === "chat" ? "correct" : e.kind === "notapprove" ? "correct" : "missed";
  }
  // clean up
  for (const k of sc.open) if (!decisions[k]) answerReaction("👎", sent[k]!);
  await Promise.all(pending);
  return { id: c.id, tag: c.tag, text: c.text.slice(0, 60), scenario: c.scenario, outcome: a.outcome, resolved: first ? `${resolved.join("+")}:${d!.approved ? (d!.updatedInput ? "modified" : "approved") : d!.feedback ? "feedback" : "declined"}` : "-", result, ms, reply: a.reply ?? a.note };
}

const passes = (process.argv[3] ?? "strict:cold,strict:warm,soft:cold,soft:warm,conversational:warm").split(",").map((p) => p.split(":") as [Style, string]);
const out: Record<string, { rows: Row[]; costUsd: number }> = {};
for (const [style, temp] of passes) {
  const before = spentToday();
  const rows: Row[] = [];
  for (const c of CORPUS) {
    const row = await runCase(c, style, temp === "warm");
    rows.push(row);
    console.log(`${style}:${temp} #${row.id} [${row.tag}] ${JSON.stringify(row.text)} -> ${row.outcome} ${row.resolved} ${row.result} ${row.ms}ms`);
  }
  out[`${style}:${temp}`] = { rows, costUsd: spentToday() - before };
  writeFileSync(process.argv[2] ?? "approval-eval.json", JSON.stringify({ out, written: Object.fromEntries(written) }, null, 1));
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
console.log("\npass                  n  FALSE_APPR false_decl over_clar missed hijack safe_other correct  judged-p50  max   cost$");
for (const [k, v] of Object.entries(out)) {
  const cnt = (r: Row["result"]) => v.rows.filter((x) => x.result === r).length;
  const slow = v.rows.filter((x) => x.ms > 150).map((x) => x.ms); // calls to the model; fast paths take no time
  console.log(`${k.padEnd(20)} ${String(v.rows.length).padStart(3)} ${String(cnt("FALSE_APPROVAL")).padStart(9)} ${String(cnt("false_decline")).padStart(10)} ${String(cnt("over_clarify")).padStart(8)} ${String(cnt("missed")).padStart(6)} ${String(cnt("hijacked_chat")).padStart(6)} ${String(cnt("safe_other")).padStart(10)} ${String(cnt("correct")).padStart(7)} ${String(slow.length ? pct(slow, 0.5) : 0).padStart(10)} ${String(slow.length ? Math.max(...slow) : 0).padStart(6)} ${v.costUsd.toFixed(3)}`);
}
process.exit(0);
