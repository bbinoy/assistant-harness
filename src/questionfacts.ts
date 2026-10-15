// The one cheap check on a model-written approval question: the facts that decide what will run
// must appear in it verbatim. No second model call. Pure.
//
// Required, taken from the exact arguments (and the code-rendered details, which for a mail send are read back from the mail client):
// every email address and URL in a structured field, ids, titles/subjects, the time zone, every start and end time (HH:MM) and
// date (D Mon), amounts, and the words Cc / Bcc when there are such recipients. Forbidden: an address or URL the arguments do not
// contain (an invented recipient). What this CANNOT check: what the question says about the action in words ("replace" vs "add",
// "send" vs "save a draft"), or whether it repeats a claim from the email body as fact. Those rest on the writer prompt.

// Free text (a message body, notes, page content): shown in the question as a summary, not required verbatim.
const LONG_TEXT = new Set(["body", "description", "message", "text", "content", "markdownBody", "new_str", "note", "prompt", "old_str"]);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const AMOUNT = /\d[\d.,]*\s?(?:€|EUR|USD|GBP|CHF|\$|£)/g;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ID_KEY = /(^id$|Id$|_id$)/;
const TITLE_KEYS = new Set(["summary", "title", "subject"]);

export interface Facts {
  must: string[]; // appear verbatim (case-insensitive for addresses and words)
  words: RegExp[]; // role words that must appear (Cc, Bcc)
  allowed: Set<string>; // every address and URL the arguments and details contain: no others may appear
}

function walk(v: unknown, key: string, f: (key: string, value: string | number) => void, depth = 0): void {
  if (depth > 6) return;
  if (typeof v === "string" || typeof v === "number") return f(key, v);
  if (Array.isArray(v)) return v.forEach((x) => walk(x, key, f, depth + 1));
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k, f, depth + 1);
}

const add = (xs: string[], x: string) => void (x && !xs.some((y) => y.toLowerCase() === x.toLowerCase()) && xs.push(x));
const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "");

export function factsOf(args: Record<string, unknown>, details: string): Facts {
  const must: string[] = [];
  const allowed = new Set<string>();
  const words: RegExp[] = [];
  const roles = new Set<string>();
  let amounts = 0;
  walk(args, "", (key, value) => {
    const s = String(value);
    for (const m of s.matchAll(EMAIL)) {
      allowed.add(m[0].toLowerCase());
      if (!LONG_TEXT.has(key)) add(must, m[0]);
    }
    for (const m of s.matchAll(URL_RE)) {
      allowed.add(trimUrl(m[0]).toLowerCase());
      if (!LONG_TEXT.has(key)) add(must, trimUrl(m[0]));
    }
    if (/^(cc|bcc)$/i.test(key) && s.trim()) roles.add(key.toLowerCase());
    if (ID_KEY.test(key) && key !== "calendarId" && s !== "primary" && s.length <= 80) add(must, s);
    if (TITLE_KEYS.has(key) && s.length <= 120 && s.trim()) add(must, s.trim());
    if (/^time_?zone$/i.test(key) && s) add(must, s);
    if (!LONG_TEXT.has(key)) {
      const t = ISO.exec(s);
      if (t) {
        add(must, `${Number(t[3])} ${MONTHS[Number(t[2]) - 1]}`);
        if (t[4] !== undefined) add(must, `${t[4]}:${t[5]}`);
      }
    }
    for (const m of s.matchAll(AMOUNT)) if (amounts++ < 5) add(must, m[0].trim());
  });
  // The details are ground truth for what code read back (a mail send's draft): their address lines count too.
  for (const line of details.split("\n")) {
    const h = /^(To|Cc|Bcc|With|Address|Where):\s*(.*)$/.exec(line);
    if (!h) continue;
    if (/^cc$/i.test(h[1]!) && h[2]!.trim()) roles.add("cc");
    if (/^bcc$/i.test(h[1]!) && h[2]!.trim()) roles.add("bcc");
    for (const m of h[2]!.matchAll(EMAIL)) (allowed.add(m[0].toLowerCase()), add(must, m[0]));
    for (const m of h[2]!.matchAll(URL_RE)) (allowed.add(trimUrl(m[0]).toLowerCase()), add(must, trimUrl(m[0])));
  }
  if (roles.has("bcc")) words.push(/\bbcc\b|blind/i);
  if (roles.has("cc")) words.push(/\bcc\b|carbon/i);
  return { must, words, allowed };
}

// Undefined when the question carries every fact; else the first thing wrong (for the audit log).
export function validateQuestion(text: string, facts: Facts): string | undefined {
  const lower = text.toLowerCase();
  for (const m of facts.must) if (!lower.includes(m.toLowerCase())) return `missing "${m.slice(0, 80)}"`;
  for (const w of facts.words) if (!w.test(text)) return `does not say who is on ${w.source.includes("bcc") ? "Bcc" : "Cc"}`;
  for (const m of text.matchAll(EMAIL)) if (!facts.allowed.has(m[0].toLowerCase())) return `unknown address ${m[0]}`;
  for (const m of text.matchAll(URL_RE)) if (!facts.allowed.has(trimUrl(m[0]).toLowerCase())) return `unknown address ${trimUrl(m[0])}`;
  return undefined;
}
