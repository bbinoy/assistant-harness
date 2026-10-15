import { factsOf, validateQuestion } from "./questionfacts.ts";

// The common approval question needs no model: code already holds every fact (what, to whom, when, amounts) in the details text it
// rendered from the exact arguments (format.ts describeCall), so the question is that text with a plain lead-in and a closing ask.
// The model writes the question (approvalmodel.ts) only for what this cannot express well: long text to summarise, a call code
// has no title for. The result still goes through the same fact check as a model-written question.

const MAX_CHARS = 600; // beyond this the owner is better served by a summary
const MAX_LINES = 12;
const CUT = /more characters not shown|the quoted original follows/;

// Undefined when the details are not simple enough to be read as they are.
export function templateQuestion(a: { tool: string; args: Record<string, unknown>; details: string; background: boolean }): string | undefined {
  const details = a.details.trim();
  if (!details || details.length > MAX_CHARS || details.split("\n").length > MAX_LINES || CUT.test(details)) return undefined;
  if (details.startsWith("❓")) return undefined; // a tool code has no title for: let the model say what it is
  const text = `${a.background ? "A background task asks to:\n" : ""}${details}\n\nGo ahead?`;
  return validateQuestion(text, factsOf(a.args, a.details)) ? undefined : text;
}
