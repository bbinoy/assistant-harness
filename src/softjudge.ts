import { audit, type Source } from "./audit.ts";
import { runJudge, withTimeout } from "./approvaljudge.ts";
import type { JudgeIO } from "./judgespare.ts";
import { answerPrompt, checkPrompt, parseAnswer, parseCheck, parseWrite, writePrompt, type AnswerJudgement, type OpenView, type Recent } from "./softprompt.ts";

// The model calls of APPROVAL_STYLE soft / conversational. Each one fails closed: a thrown error, a timeout, an error result, an
// answer for the wrong task or one that is not an exact enum value is "no answer" (undefined / inaccurate), never an approval.

// Resolves undefined when the judge gave no usable answer; the caller then treats the reply as a normal chat message.
export async function judgeAnswer(reply: string, open: readonly OpenView[], recent: readonly Recent[], quotedId?: string, io: JudgeIO = {}, timeoutMs = 20_000): Promise<AnswerJudgement | undefined> {
  const started = Date.now();
  try {
    const r = await withTimeout(runJudge("answer", answerPrompt(reply, open, recent, quotedId), io), timeoutMs);
    const j = r && parseAnswer(r.out, open.map((o) => o.id));
    console.log(`judge: answer ${j ? `-> ${j.target} ${j.outcome}` : "no usable result"} (${Date.now() - started}ms${r?.warm ? ", warm" : ", cold"})`);
    return j;
  } catch (e) {
    console.error("judge error:", (e as Error).message);
    return undefined;
  }
}

export interface QuestionInput {
  tool: string;
  args: Record<string, unknown>;
  details: string; // the deterministic text (format.ts): ground truth, and the fallback
  recent: readonly Recent[];
  background: boolean;
  source: Source;
}
export interface Composed {
  text: string; // what is sent as the question
  written: boolean; // model-written (false: the code text)
  attempts: number;
  mismatches: string[]; // why the check refused a written question, one per try
  failure?: string; // why the code text was used
}

type Run = (task: "write" | "check", prompt: string) => Promise<unknown>;
const viaJudge = (io: JudgeIO, ms: number): Run => async (task, prompt) => (await withTimeout(runJudge(task, prompt, io), ms))?.out;

// Conversational wording: a model writes the question, a second call that sees only the arguments and the question checks it. A
// refused or failed write is retried once with the reason; after that the code text is used, so a divergence never reaches the
// owner silently. Every mismatch is audited (with the full arguments) so the writer prompt can be tightened. Never throws.
export async function composeQuestion(q: QuestionInput, io: JudgeIO = {}, timeoutMs = 15_000, run: Run = viaJudge(io, timeoutMs)): Promise<Composed> {
  const out: Composed = { text: q.details, written: false, attempts: 0, mismatches: [] };
  let rejected: string | undefined;
  for (let i = 0; i < 2; i++) {
    out.attempts++;
    try {
      const text = parseWrite(await run("write", writePrompt({ ...q, rejected })));
      if (!text) {
        out.failure = "no usable question from the writer";
        rejected = "the answer was empty or unusable";
        continue;
      }
      const verdict = parseCheck(await run("check", checkPrompt({ tool: q.tool, args: q.args, details: q.details, question: text })));
      if (verdict.accurate) return { ...out, text, written: true, failure: undefined };
      rejected = verdict.reason ?? "the check could not confirm it";
      out.mismatches.push(rejected);
      out.failure = `check refused the question: ${rejected}`;
      audit(q.tool, "question-mismatch", q.source, { attempt: i + 1, reason: rejected, question: text, details: q.details });
    } catch (e) {
      out.failure = (e as Error).message;
      rejected = undefined;
    }
  }
  console.log(`question: using the code text (${out.failure})`);
  return out;
}
