import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { addressProblem, BROWSER_PREFIX, classifyClick, dnsResolver, hostOf, isAllowedBrowserTool, isRef, parseSnapshot, resolvesPublic, sensitiveKind, type Node, type Resolver } from "./browserules.ts";
import { audit } from "./audit.ts";
import { clip } from "./format.ts";
import { cleanText } from "./sanitize.ts";
import { settings } from "./settings.ts";

// The guard of a browse run: it decides every call the browsing model makes (browserules.ts has the pure rules). One per run.

export type BrowseMode = "owner" | "group";

// ---- the guard: one per browse run ----

export interface Decision {
  kind: "deny" | "allow" | "ask" | "defer"; // defer: the manifest and the approval judge decide (policy.ts, permissions.ts)
  reason?: string; // deny: what the model is told
  description?: string; // ask, and what the judge reads: built by code from the real element
  once?: boolean; // an approved call is not repeated (a commit)
  judge?: boolean; // ask: the approval judge decides whether the owner is asked (every commit step); anything but its "auto" asks the owner
  redacted?: Record<string, unknown>; // ask: the call as the owner's question and the audit may see it (typed secrets cut to a length)
  facts?: Record<string, unknown>; // ask: host, role and name of the element, added to the judge's audit row
}

export interface GuardOptions {
  mode: BrowseMode;
  task: string;
  outDir: string;
  maxCommits?: number;
  resolver?: Resolver;
}

const SNAPSHOT_CAP = 24_000; // characters (~7k tokens) of one page view: bigger ones are cut with a visible marker (MCP results over 25k tokens would be written to a file the run cannot read)
const MAX_DENIED = 6;
const nolabel = (s: string) => s.replace(/\s*:\s*$/, ""); // "Customer name:" as the page labels it
const HIDDEN = "(hidden: payment or login detail)";
const short = (tool: string) => tool.slice(BROWSER_PREFIX.length);

export class BrowseGuard {
  readonly mode: BrowseMode;
  readonly task: string;
  readonly outDir: string;
  nodes = new Map<string, Node>(); // the elements of the last page view
  typed = new Map<string, { label: string; value: string }>(); // what was typed since the page last changed
  url = "";
  commits = 0;
  denied = 0;
  steps = 0;
  private readonly maxCommits: number;
  private readonly resolver: Resolver;
  private pending?: string; // the commit call that was asked about: counted when that very call succeeds

  constructor(o: GuardOptions) {
    this.mode = o.mode;
    this.task = o.task;
    this.outDir = o.outDir;
    this.maxCommits = o.maxCommits ?? settings.browseMaxCommits;
    this.resolver = o.resolver ?? dnsResolver;
  }

  private log(tool: string, verdict: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    // Typed values are logged as a length, never as text.
    const lens = typeof input.text === "string" ? { textLength: input.text.length } : Array.isArray(input.fields) ? { fieldLengths: (input.fields as { value?: unknown }[]).map((f) => String(f?.value ?? "").length) } : {};
    audit("browse_step", verdict, "browse", { mode: this.mode, tool: short(tool), host: hostOf(typeof input.url === "string" ? input.url : this.url), ...lens, ...extra });
  }
  private deny(tool: string, input: Record<string, unknown>, reason: string, extra: Record<string, unknown> = {}): Decision {
    this.denied++;
    this.log(tool, "deny", input, { reason: reason.slice(0, 120), ...extra });
    return { kind: "deny", reason };
  }
  private refNode(ref: unknown): Node | string {
    if (!isRef(ref)) return "Use an element ref from a page view (like e12), not a selector or a description.";
    return this.nodes.get(ref) ?? `${String(ref)} is not in the last page view. Take a fresh browser_snapshot and use a ref from it.`;
  }

  // The page address without query or fragment (a query can be long and carry data; the host and path say where the owner is).
  private where(): string {
    try {
      const u = new URL(this.url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return "(unknown)";
    }
  }

  // What the owner and the judge read before a commit step: the page, the real control, and what has been entered, all from code.
  // A payment or login value that is on the page or was typed is never repeated here.
  private commitText(control: string, why: string, extraValues: [string, string][] = [], form?: string): string {
    const rows = new Map<string, string>();
    for (const n of this.nodes.values()) if ((n.value || n.checked) && n.role !== "link") rows.set(n.ref, `${nolabel(n.name) || n.role}: ${n.value && sensitiveKind(n.name, n.value) ? HIDDEN : (n.value ?? (n.checked ? "ticked" : ""))}`);
    for (const [ref, t] of this.typed) rows.set(ref, `${nolabel(t.label) || ref}: ${t.value}`);
    for (const [label, value] of extraValues) rows.set(`x${label}`, `${nolabel(label)}: ${value}`);
    const values = [...rows.values()].slice(0, 30).map((r) => `• ${clip(r, 160)}`);
    return [
      "🛒 Browser: confirm this step",
      `Site: ${clip(hostOf(this.url) || "(unknown)", 100)}`,
      `Address: ${clip(this.where(), 300)}`,
      control,
      ...(form ? [`Form: ${clip(form, 100)}`] : []),
      `Why you are asked: ${why}`,
      values.length ? `Entered so far:\n${values.join("\n")}` : "Entered so far: nothing visible",
      `Task: ${clip(this.task, 300)}`,
      "Approve only if this is exactly what you want done.",
    ].join("\n");
  }

  // Every step the classifier takes for a commit goes to the approval judge with this text; the judge (or, failing that, the owner) decides.
  private commit(tool: string, input: Record<string, unknown>, node: Node | undefined, why: string, control: string, extraValues: [string, string][] = []): Decision {
    if (this.commits >= this.maxCommits) return this.deny(tool, input, `This run already took its ${this.maxCommits} confirmed step(s). Stop and report what is left for the owner.`, { commit: true, cap: true });
    this.log(tool, "judge", input, { commit: true, why, role: node?.role, name: node?.name?.slice(0, 80) });
    this.pending = tool + JSON.stringify(input);
    return { kind: "ask", description: this.commitText(control, why, extraValues, node?.formName), once: true, judge: true, facts: { host: hostOf(this.url), role: node?.role, name: node?.name?.slice(0, 80), step: short(tool) } };
  }

  // Payment and login fields: the owner is ALWAYS asked (no judge, no cap, no skipping). The question names the page, the field and the kind of
  // value, never the value; the typed text goes only to the browser. `redacted` is the call as the question and the audit see it.
  private sensitive(tool: string, input: Record<string, unknown>, fields: { name: string; kind: string }[]): Decision {
    this.log(tool, "ask-sensitive", input, { sensitive: true, kinds: fields.map((f) => f.kind) });
    const redacted: Record<string, unknown> = { ...input };
    if (typeof input.text === "string") redacted.text = `[${input.text.length} characters, not shown]`;
    if (Array.isArray(input.fields)) redacted.fields = (input.fields as Record<string, unknown>[]).map((f) => ({ ...f, value: `[${String(f?.value ?? "").length} characters, not shown]` }));
    const list = fields.map((f) => `• ${clip(nolabel(f.name) || "(no label)", 80)}: ${f.kind}`);
    return {
      kind: "ask",
      once: true,
      redacted,
      description: ["🔐 Browser: a payment or login detail", `Site: ${clip(hostOf(this.url) || "(unknown)", 100)}`, `Address: ${clip(this.where(), 300)}`, `Field${fields.length > 1 ? "s" : ""}:\n${list.join("\n")}`, "The value is typed into the page by the browser and is not shown here or logged.", `Task: ${clip(this.task, 300)}`, "Approve only if you want this entered."].join("\n"),
    };
  }

  async decide(toolName: string, input: Record<string, unknown>): Promise<Decision> {
    this.steps++;
    if (this.denied >= MAX_DENIED) return this.deny(toolName, input, "Too many refused calls in this run. Stop now and report what you have.");
    if (toolName === "WebSearch") return { kind: "defer" };
    if (!toolName.startsWith("mcp__browser__")) return this.deny(toolName, input, `${toolName} is not available in a browse run.`);
    if (!isAllowedBrowserTool(toolName)) return this.deny(toolName, input, `${short(toolName)} is not available.`);
    const name = short(toolName);
    switch (name) {
      case "navigate":
      case "tabs": {
        if (name === "tabs" && typeof input.url !== "string") return { kind: "defer" };
        const bad = addressProblem(input.url);
        if (bad) return this.deny(toolName, input, `Cannot open that address: ${bad}.`, { address: clip(String(input.url ?? ""), 80) });
        if (!(await resolvesPublic(hostOf(input.url), this.resolver))) return this.deny(toolName, input, "Cannot open that address: the name points to a private address.");
        this.log(toolName, "nav", input);
        return { kind: "defer", description: `🌐 Browser: open a page\nAddress: ${clip(String(input.url), 300)}` };
      }
      case "type": {
        const n = this.refNode(input.target);
        if (typeof n === "string") return this.deny(toolName, input, n);
        const text = String(input.text ?? "");
        const kind = sensitiveKind(n.name, text);
        if (kind) return this.sensitive(toolName, input, [{ name: n.name, kind }]);
        if (input.submit === true) return this.commit(toolName, input, n, "typing with Enter would submit the form", `Typing into “${clip(n.name || n.ref, 120)}” (${n.role}) and pressing Enter`, [[n.name || n.ref, text]]);
        this.log(toolName, "type", input, { role: n.role, name: n.name.slice(0, 60) });
        return { kind: "defer", description: `⌨️ Browser: type into “${clip(n.name || n.ref, 80)}” (${n.role})\nSite: ${clip(hostOf(this.url), 100)}\nText: ${clip(text, 200)}` };
      }
      case "fill_form": {
        const fields = Array.isArray(input.fields) ? (input.fields as Record<string, unknown>[]) : [];
        const lines: string[] = [];
        const secret: { name: string; kind: string }[] = [];
        for (const f of fields) {
          const n = this.refNode(f.target);
          if (typeof n === "string") return this.deny(toolName, input, n);
          const kind = sensitiveKind(n.name, String(f.value ?? "")) ?? sensitiveKind(String(f.name ?? ""));
          if (kind) {
            secret.push({ name: n.name || String(f.name ?? ""), kind });
            continue;
          }
          lines.push(`• ${clip(n.name || n.ref, 80)}: ${clip(String(f.value ?? ""), 160)}`);
        }
        if (secret.length) return this.sensitive(toolName, input, secret);
        this.log(toolName, "fill", input);
        return { kind: "defer", description: `⌨️ Browser: fill in a form\nSite: ${clip(hostOf(this.url), 100)}\n${lines.join("\n")}` };
      }
      case "select_option": {
        const n = this.refNode(input.target);
        if (typeof n === "string") return this.deny(toolName, input, n);
        this.log(toolName, "select", input, { role: n.role });
        return { kind: "defer", description: `⌨️ Browser: choose “${clip(Array.isArray(input.values) ? input.values.join(", ") : "", 120)}” in “${clip(n.name || n.ref, 80)}”\nSite: ${clip(hostOf(this.url), 100)}` };
      }
      case "press_key": {
        // Enter or Space on a focused control can submit a form or press a button: after typing, that is treated as a commit step.
        if (/^(Enter|NumpadEnter|Space| )$/.test(String(input.key ?? "")) && this.typed.size > 0) return this.commit(toolName, input, undefined, `pressing ${String(input.key)} after typing can submit the form`, `Key press: ${String(input.key)} (on the control that has focus)`);
        return { kind: "defer" };
      }
      case "handle_dialog":
        return input.accept === true ? this.commit(toolName, input, undefined, "accepting a page dialog", "Page dialog: accept it") : { kind: "defer" };
      case "click": {
        const n = this.refNode(input.target);
        if (typeof n === "string") {
          // A stale or unknown ref is not a reason to ask the owner: the call is refused and the worker told to look again. Never clicked unseen.
          if (!isRef(input.target)) return this.deny(toolName, input, n);
          this.log(toolName, "deny", input, { reason: "stale ref", stale: true }); // not counted toward the run's refusals: it is the page moving, not a misstep
          return { kind: "deny", reason: `${String(input.target)} is not in the last page view (the page changed, or the ref is old). Take a fresh browser_snapshot and click a ref from it.` };
        }
        if (n.url) {
          let abs = n.url;
          try {
            abs = new URL(n.url, this.url || "https://invalid.invalid/").toString();
          } catch {
            // a link that is not an address at all: addressProblem says so
          }
          const bad = /^#/.test(n.url) ? undefined : addressProblem(abs);
          if (bad) return this.deny(toolName, input, `That link is not allowed: ${bad}.`, { role: n.role });
        }
        const c = classifyClick(n);
        this.log(toolName, c.commit ? "commit-check" : "click", input, { role: n.role, name: n.name.slice(0, 80), commit: c.commit });
        if (c.commit) return this.commit(toolName, input, n, c.why, `Button: “${clip(n.name || "(no label)", 120)}” (${n.role})`);
        return { kind: "defer", description: `🖱️ Browser: click “${clip(n.name || n.ref, 80)}” (${n.role})` };
      }
      default:
        return { kind: "defer" }; // snapshot, find, navigate_back, hover, wait_for: reads
    }
  }

  // After a call succeeded: what the model will read (a linked snapshot file read in, a page view cut to size), and what code remembers.
  // Returns the new text, or undefined to leave the result as it is.
  shape(toolName: string, input: Record<string, unknown>, text: string): string | undefined {
    let out = text;
    const link = /^- \[Snapshot\]\(([^)]+)\)\s*$/m.exec(out);
    if (link) {
      const path = resolve(link[1]!);
      if (path.startsWith(resolve(this.outDir) + sep)) {
        try {
          out = out.replace(link[0], "```yaml\n" + readFileSync(path, "utf8") + "\n```");
        } catch {
          // the file is gone: the model can ask for a snapshot
        }
      }
    }
    const seen = /Page URL: (\S+)/.exec(out)?.[1];
    if (seen && addressProblem(seen)) {
      this.nodes.clear();
      this.url = "";
      return `### Page\nThe page went to an address that is not allowed (${addressProblem(seen)}); its content is withheld. Go back or stop.`;
    }
    out = cleanText(out).text; // refs and names are remembered as the model will read them, hidden characters out
    if (out.length > SNAPSHOT_CAP) out = `${out.slice(0, SNAPSHOT_CAP)}\n[... ${out.length - SNAPSHOT_CAP} characters of the page view cut: use browser_find for what you need, or a narrower page]`;
    if (/\[ref=|### Snapshot|Page URL/.test(out)) audit("browse_view", "page", "browse", { tool: short(toolName), chars: out.length, cut: out.length > SNAPSHOT_CAP, fromFile: !!link });
    this.remember(toolName, input, out, seen);
    return out === text ? undefined : out;
  }

  remember(toolName: string, input: Record<string, unknown>, text: string, seen: string | undefined) {
    const name = short(toolName);
    if (seen && seen !== this.url) (this.typed.clear(), (this.url = seen));
    if (name === "navigate" || name === "navigate_back") this.typed.clear();
    if (/\[ref=/.test(text)) {
      const fresh = parseSnapshot(text);
      if (name === "find") for (const [k, v] of fresh) this.nodes.set(k, v);
      else this.nodes = fresh;
    }
    if (name === "type" && isRef(input.target)) {
      const label = this.nodes.get(String(input.target))?.name ?? "";
      this.typed.set(String(input.target), { label, value: sensitiveKind(label, String(input.text ?? "")) ? HIDDEN : String(input.text ?? "") });
    }
    if (name === "fill_form" && Array.isArray(input.fields)) for (const f of input.fields as Record<string, unknown>[]) if (isRef(f.target)) {
      const label = String(f.name ?? this.nodes.get(String(f.target))?.name ?? "");
      this.typed.set(String(f.target), { label, value: sensitiveKind(label, String(f.value ?? "")) || sensitiveKind(this.nodes.get(String(f.target))?.name ?? "") ? HIDDEN : String(f.value ?? "") });
    }
    if (this.pending !== undefined && this.pending === toolName + JSON.stringify(input)) {
      this.commits++;
      this.pending = undefined;
    }
  }
}

// The text of a tool result, whatever its shape (a string, {content: [...]}, or the blocks themselves), and the same result with new text.
type Block = { type?: string; text?: string };
const blocksOf = (r: unknown): Block[] | undefined => (Array.isArray(r) ? (r as Block[]) : r && typeof r === "object" && Array.isArray((r as { content?: unknown }).content) ? (r as { content: Block[] }).content : undefined);
export function resultText(r: unknown): string {
  if (typeof r === "string") return r;
  const b = blocksOf(r);
  return b ? b.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n") : "";
}
export function withText(r: unknown, text: string): unknown {
  if (typeof r === "string") return text;
  const b = blocksOf(r);
  if (!b) return r;
  let put = false;
  const next = b.flatMap((x) => (x?.type === "text" ? (put ? [] : ((put = true), [{ ...x, text }])) : [x]));
  return Array.isArray(r) ? next : { ...(r as object), content: next };
}
