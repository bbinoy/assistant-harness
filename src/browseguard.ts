import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { addressProblem, BROWSER_PREFIX, classifyClick, dnsResolver, findTotal, hostOf, isAllowedBrowserTool, isRef, parseSnapshot, resolvesPublic, sensitiveKind, type Node, type Resolver, type VisionMode } from "./browserules.ts";
import { hostMatches } from "./domains.ts";
import { fieldFitsKey, isSensitive, maskValue, type Profile } from "./profile.ts";
import type { Probe } from "./browsecdp.ts";
import { clickProblem, MAX_POINT_CLICKS, MAX_SHOTS, nodeOfPoint, screenshotInput, validPoint } from "./browsevision.ts";
import { audit } from "./audit.ts";
import { clip } from "./format.ts";
import { cleanText, LIMITS } from "./sanitize.ts";
import { isJpeg, MAX_PICTURE_BYTES } from "./shots.ts";
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
  input?: Record<string, unknown>; // the call as it must run, when code narrowed it (a screenshot: jpeg, viewport only)
}

export interface GuardOptions {
  mode: BrowseMode;
  task: string;
  outDir: string;
  maxCommits?: number;
  resolver?: Resolver;
  vision?: VisionMode; // the vision experiment (browsevision.ts); off: today's behaviour
  probe?: Probe; // click mode: what is under a point of the page, looked up by code (browsecdp.ts)
  cdpPort?: number; // click mode: the browser's debugging port on loopback (browseserver.ts starts the browser with it)
  shotsDir?: string; // vision on: where each screenshot is kept as a small jpeg, for the chat to pass on (shots.ts)
  profile?: Profile; // the owner's saved details (profile.ts): the owner's chat run only, a group's guard ignores it
}

// A saved detail typed by code: the model names a key, never sees the value.
const WHOLE_PLACEHOLDER = /^\{\{profile:([a-z][a-z0-9._-]*)\}\}$/i;
const HAS_PLACEHOLDER = /\{\{\s*profile:/i;
const FIELD_ROLES = /^(textbox|searchbox|combobox|spinbutton)$/;
interface FillIntent { ref: string; label: string; key: string; shown: string; sensitive: boolean }
export interface FilledField { host: string; label: string; key: string; shown: string; sensitive: boolean }
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SNAPSHOT_CAP = LIMITS.pageView; // bigger page views are cut with a visible marker
const MAX_DENIED = 6;
const AUTOFILL_SENSITIVE = /\b(cc-[a-z-]+|current-password|new-password|one-time-code)\b/i; // autocomplete tokens of card and login fields
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
  readonly vision: VisionMode;
  readonly cdpPort?: number;
  private readonly probe?: Probe;
  private shots = 0;
  readonly shotsDir?: string;
  kept: { id: string; file: string; size: number }[] = []; // the screenshots kept for the chat, in order
  private pointClicks = 0;
  private pending?: string; // the commit call that was asked about: counted when that very call succeeds
  private readonly profile?: Profile;
  private readonly secrets = new Set<string>(); // values typed from the profile: cut from everything the model reads, for the rest of the run
  private readonly fillRefs = new Set<string>(); // the refs they went into: the page view shows the value on those lines
  private readonly intents = new Map<string, FillIntent>(); // decided to fill, not yet confirmed done
  private justFilled = new Set<string>();
  filled: FilledField[] = []; // what was typed from the profile in this run (labels, keys, masked values), for the final approval
  private viewUrl = ""; // the address of the page view the refs come from
  private view = ""; // the last full page view, as the model reads it (for the total)

  constructor(o: GuardOptions) {
    this.mode = o.mode;
    this.task = o.task;
    this.outDir = o.outDir;
    this.maxCommits = o.maxCommits ?? settings.browseMaxCommits;
    this.resolver = o.resolver ?? dnsResolver;
    this.vision = o.vision ?? "off";
    this.probe = o.probe;
    this.cdpPort = o.cdpPort;
    this.shotsDir = o.shotsDir;
    this.profile = o.mode === "owner" ? o.profile : undefined;
  }

  // What the judge and the owner read for typing saved details: label, key and site, never the value.
  private fillDescription(list: FillIntent[]): string {
    return `⌨️ Browser: type saved details from the owner's profile (the value is typed by code and not shown)\nSite: ${clip(hostOf(this.url), 100)}\n${list.map((i) => `• “${clip(i.label, 80)}” ← ${i.key}`).join("\n")}`;
  }

  // The saved keys (never values) the worker may name, for its prompt.
  profileKeys(): { key: string; kind: string }[] {
    return Object.entries(this.profile?.entries ?? {}).map(([key, e]) => ({ key, kind: e.kind })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  // Why the saved detail `text` ("{{profile:KEY}}") may not go into this field, or the value and what to remember about it. Everything here is code.
  private fillFrom(n: Node, text: string): { value: string; intent: FillIntent } | string {
    const m = WHOLE_PLACEHOLDER.exec(text.trim());
    if (!m) return "A saved detail is typed as the whole text, exactly {{profile:KEY}}, nothing around it.";
    if (!this.profile) return "No saved details are available in this run. Use only what the task gives you, or stop with status needs_owner.";
    const key = m[1]!.toLowerCase();
    const e = this.profile.entries[key];
    if (!e) return `There is no saved detail called ${clip(key, 40)}. The keys are: ${this.profileKeys().map((k) => k.key).join(", ")}.`;
    if (/^f\d+e/.test(n.ref)) return "That field is inside an embedded frame whose content and origin cannot be checked, so a saved detail is not typed there. Stop with status needs_owner and give handoffUrl.";
    let u: URL;
    try {
      u = new URL(this.url);
    } catch {
      return "No page is open. Navigate first.";
    }
    if (u.protocol !== "https:") return "Saved details are only typed on https pages.";
    if (!this.viewUrl || this.viewUrl !== this.url) return "The page changed since the last page view. Take a fresh browser_snapshot and use a ref from it.";
    if (!FIELD_ROLES.test(n.role)) return `${n.ref} is a ${n.role}, not a text field.`;
    if (sensitiveKind(n.name)) return "That is a payment or login field: saved details are never typed there. Stop with status needs_owner and give handoffUrl.";
    if (!fieldFitsKey(n.name, key, e)) return `The field “${clip(n.name || n.ref, 60)}” does not look like the place for ${key}.`;
    if (e.domains.length) {
      if (!hostMatches(u.hostname, e.domains)) return `${key} is not allowed on ${clip(u.hostname, 60)}.`;
    } else if (isSensitive(e)) return `${key} is a sensitive detail and the owner has not named a site for it yet, so it is not typed anywhere.`;
    this.secrets.add(e.value);
    return { value: e.value, intent: { ref: n.ref, label: n.name || n.ref, key, shown: maskValue(e.value, isSensitive(e)), sensitive: isSensitive(e) } };
  }

  // Saved details were typed by this call: remembered for the final approval.
  private doneFills(name: string, input: Record<string, unknown>): FillIntent[] {
    const refs = name === "type" ? [String(input.target)] : name === "fill_form" && Array.isArray(input.fields) ? (input.fields as Record<string, unknown>[]).map((f) => String(f.target)) : [];
    const done: FillIntent[] = [];
    for (const r of refs) {
      const it = this.intents.get(r);
      if (!it) continue;
      this.intents.delete(r);
      done.push(it);
      this.fillRefs.add(r);
      this.justFilled.add(r);
      this.typed.set(r, { label: it.label, value: it.shown });
      const host = hostOf(this.url);
      if (!this.filled.some((f) => f.host === host && f.key === it.key && f.label === it.label)) this.filled.push({ host, label: it.label, key: it.key, shown: it.shown, sensitive: it.sensitive });
    }
    return done;
  }

  // The model never reads a saved value: it is cut from every result (the echo of the typed code, the field in a later page view, a summary on the page).
  private redact(text: string): string {
    if (!this.secrets.size) return text;
    let out = text;
    for (const ref of this.fillRefs) out = out.replace(new RegExp(`(\\[ref=${escapeRe(ref)}\\](?: \\[[^\\]]*\\])*):[ \\t].*$`, "gm"), "$1: [filled]");
    for (const v of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (v.length < 3) continue;
      for (const variant of new Set([v, JSON.stringify(v).slice(1, -1), v.replace(/'/g, "\\'"), v.replace(/\s+/g, " ")])) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(variant)}(?![\\p{L}\\p{N}])`, "gu"), "[filled]");
    }
    return out;
  }

  // The names of the buttons, links and fields of the last page view (cheap context for the judge when a point could not be resolved).
  private controlsSeen(): string {
    const names = [...this.nodes.values()].filter((n) => n.name && /^(button|link|textbox|searchbox|combobox|checkbox|radio|menuitem|tab|switch)$/.test(n.role)).slice(0, 15).map((n) => `${n.role} “${clip(n.name, 40)}”`);
    return names.length ? `Controls on the page: ${names.join(", ")}` : "Controls on the page: none listed";
  }

  // After a screenshot call succeeded: keeps its picture as a jpeg file (only real jpeg bytes, a size limit, a name code chooses) and returns its id.
  keepShot(response: unknown): string | undefined {
    if (!this.shotsDir) return undefined;
    const bytes = imageBytes(response);
    if (!bytes || bytes.length > MAX_PICTURE_BYTES || !isJpeg(bytes)) return undefined;
    const id = `shot${this.kept.length + 1}`;
    const file = join(this.shotsDir, `${id}.jpg`);
    try {
      writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    } catch {
      return undefined;
    }
    this.kept.push({ id, file, size: bytes.length });
    return id;
  }

  private log(tool: string, verdict: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    // Typed values are logged as a length, never as text.
    const lens = typeof input.text === "string" ? { textLength: input.text.length } : Array.isArray(input.fields) ? { fieldLengths: (input.fields as { value?: unknown }[]).map((f) => String(f?.value ?? "").length) } : {};
    audit("browse_step", verdict, "browse", { mode: this.mode, tool: short(tool), host: hostOf(typeof input.url === "string" ? input.url : this.url), ...lens, ...extra });
  }
  private deny(tool: string, input: Record<string, unknown>, reason: string, extra: Record<string, unknown> = {}): Decision {
    this.denied++;
    this.log(tool, "deny", input, { reason: reason.slice(0, LIMITS.reason), ...extra });
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
    const values = [...rows.values()].slice(0, 30).map((r) => `• ${clip(r, LIMITS.gist)}`);
    const here = hostOf(this.url);
    // Saved details typed in this run: field label, the key it came from, and the value (masked to its last 4 characters for a sensitive key).
    const profile = this.filled.length
      ? [
          "Profile fields filled in this run (typed by code; the assistant never saw the values):",
          ...this.filled.slice(-12).map((f) => `• ${clip(nolabel(f.label) || "(no label)", 60)} ← ${f.key}: ${f.shown}${f.host !== here ? ` (on ${f.host})` : ""}`),
          this.totalLine(),
        ]
      : [];
    return [
      "🛒 Browser: confirm this step",
      `Site: ${clip(here || "(unknown)", 100)}`,
      `Address: ${clip(this.where(), 300)}`,
      control,
      ...(form ? [`Form: ${clip(form, 100)}`] : []),
      `Why you are asked: ${why}`,
      values.length ? `Entered so far:\n${values.join("\n")}` : "Entered so far: nothing visible",
      ...profile,
      `Task: ${clip(this.task, 300)}`,
      "Approve only if this is exactly what you want done.",
    ].join("\n");
  }

  // The total as code reads it from the last page view, or says there is none. The shop's own figure: nothing here checks it.
  private totalLine(): string {
    const t = findTotal(this.view);
    return t ? `Total (read from the page by code, not checked by the shop): ${t}` : "Total: none found on the page";
  }

  // Every step the classifier takes for a commit goes to the approval judge with this text; the judge (or, failing that, the owner) decides.
  // `judge` false: the owner is asked directly. After saved details were typed in this run the owner is ALWAYS asked, whatever the judge would say.
  private commit(tool: string, input: Record<string, unknown>, node: Node | undefined, why: string, control: string, extraValues: [string, string][] = [], judge = true): Decision {
    if (this.commits >= this.maxCommits) return this.deny(tool, input, `This run already took its ${this.maxCommits} confirmed step(s). Stop and report what is left for the owner.`, { commit: true, cap: true });
    if (this.filled.length) (judge = false), (why = `${why}; details from your saved profile were typed in this run, so you always confirm`);
    this.log(tool, judge ? "judge" : "ask-owner", input, { commit: true, why, role: node?.role, name: node?.name?.slice(0, LIMITS.control), ...(this.filled.length ? { profileKeys: this.filled.map((f) => f.key) } : {}) });
    this.pending = tool + JSON.stringify(input);
    return { kind: "ask", description: this.commitText(control, why, extraValues, node?.formName), once: true, judge, facts: { host: hostOf(this.url), role: node?.role, name: node?.name?.slice(0, LIMITS.control), step: short(tool) } };
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
    if (!isAllowedBrowserTool(toolName, this.vision)) return this.deny(toolName, input, `${short(toolName)} is not available.`);
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
        this.intents.delete(n.ref);
        if (HAS_PLACEHOLDER.test(text)) {
          // A saved detail: code checks the field, the page and the site, then types the real value. The model, the question and the audit see the key.
          const logged = { target: input.target };
          if (input.submit === true) return this.deny(toolName, logged, "Do not submit while typing a saved detail. Type it, then use the page's own button.");
          const r = this.fillFrom(n, text);
          if (typeof r === "string") return this.deny(toolName, logged, r, { profile: true });
          this.intents.set(n.ref, r.intent);
          this.log(toolName, "fill-profile", logged, { role: n.role, name: n.name.slice(0, LIMITS.control), profileKey: r.intent.key, valueLength: r.value.length });
          return { kind: "defer", input: { ...input, text: r.value }, description: this.fillDescription([r.intent]) };
        }
        const kind = sensitiveKind(n.name, text);
        if (kind) return this.sensitive(toolName, input, [{ name: n.name, kind }]);
        if (input.submit === true) return this.commit(toolName, input, n, "typing with Enter would submit the form", `Typing into “${clip(n.name || n.ref, 120)}” (${n.role}) and pressing Enter`, [[n.name || n.ref, text]]);
        this.log(toolName, "type", input, { role: n.role, name: n.name.slice(0, LIMITS.control) });
        return { kind: "defer", description: `⌨️ Browser: type into “${clip(n.name || n.ref, 80)}” (${n.role})\nSite: ${clip(hostOf(this.url), 100)}\nText: ${clip(text, 200)}` };
      }
      case "fill_form": {
        const fields = Array.isArray(input.fields) ? (input.fields as Record<string, unknown>[]) : [];
        const lines: string[] = [];
        const secret: { name: string; kind: string }[] = [];
        const real: Record<string, unknown>[] = [];
        const mine: FillIntent[] = [];
        for (const f of fields) {
          const n = this.refNode(f.target);
          if (typeof n === "string") return this.deny(toolName, input, n);
          this.intents.delete(n.ref);
          if (HAS_PLACEHOLDER.test(String(f.value ?? ""))) {
            const logged = { target: f.target };
            const r = this.fillFrom(n, String(f.value));
            if (typeof r === "string") return this.deny(toolName, logged, r, { profile: true });
            mine.push(r.intent);
            real.push({ ...f, value: r.value });
            continue;
          }
          real.push(f);
          const kind = sensitiveKind(n.name, String(f.value ?? "")) ?? sensitiveKind(String(f.name ?? ""));
          if (kind) {
            secret.push({ name: n.name || String(f.name ?? ""), kind });
            continue;
          }
          lines.push(`• ${clip(n.name || n.ref, 80)}: ${clip(String(f.value ?? ""), 160)}`);
        }
        if (secret.length) return this.sensitive(toolName, input, secret);
        if (mine.length) {
          for (const it of mine) this.intents.set(it.ref, it);
          this.log(toolName, "fill-profile", { fields: fields.map((f) => ({ value: HAS_PLACEHOLDER.test(String(f.value ?? "")) ? "" : f.value })) }, { profileKeys: mine.map((m) => m.key) });
          return { kind: "defer", input: { ...input, fields: real }, description: `${this.fillDescription(mine)}${lines.length ? `\n${lines.join("\n")}` : ""}` };
        }
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
        this.log(toolName, c.commit ? "commit-check" : "click", input, { role: n.role, name: n.name.slice(0, LIMITS.control), commit: c.commit });
        if (c.commit) return this.commit(toolName, input, n, c.why, `Button: “${clip(n.name || "(no label)", 120)}” (${n.role})`);
        return { kind: "defer", description: `🖱️ Browser: click “${clip(n.name || n.ref, 80)}” (${n.role})` };
      }
      case "take_screenshot": {
        if (this.shots >= MAX_SHOTS) return this.deny(toolName, input, `This run already took ${MAX_SHOTS} screenshots. Work from the page views, or stop and report.`);
        const r = screenshotInput(input);
        if ("deny" in r) return this.deny(toolName, input, r.deny);
        this.shots++;
        this.log(toolName, "shot", input);
        return { kind: "defer", input: r.input };
      }
      case "mouse_move_xy": {
        const p = validPoint(input.x, input.y);
        if (typeof p === "string") return this.deny(toolName, input, p);
        this.log(toolName, "hover-point", input);
        return { kind: "defer" };
      }
      case "mouse_wheel": {
        const ok = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 5000);
        if (!ok(input.deltaX) || !ok(input.deltaY)) return this.deny(toolName, input, "The scroll amount must be a number up to 5000.");
        return { kind: "defer" };
      }
      case "mouse_click_xy":
        return this.clickAt(toolName, input);
      default:
        return { kind: "defer" }; // snapshot, find, navigate_back, hover, wait_for: reads
    }
  }

  // A click at a point (BROWSE_VISION=click). The model's idea of what is there counts for nothing: code asks the browser what the click
  // would hit (browsecdp.ts), turns that into a Node and decides it as it decides a ref click. What it cannot resolve goes to the judge;
  // payment and login fields always ask; a link must pass the address check.
  private async clickAt(tool: string, input: Record<string, unknown>): Promise<Decision> {
    const bad = clickProblem(input);
    if (bad) return this.deny(tool, input, bad);
    const pt = validPoint(input.x, input.y);
    if (typeof pt === "string") return this.deny(tool, input, pt);
    if (!this.probe) return this.deny(tool, input, "Clicking at a point is not available in this run. Click by ref.");
    if (++this.pointClicks > MAX_POINT_CLICKS) return this.deny(tool, input, `This run already made ${MAX_POINT_CLICKS} clicks at points. Stop and report.`);
    const at = `(${Math.round(pt.x)}, ${Math.round(pt.y)})`;
    const where = this.url || undefined;
    let info = await this.probe(pt.x, pt.y, where);
    if (typeof info === "string") info = await this.probe(pt.x, pt.y, where); // one retry: a lookup can fail once while the page settles
    // What code cannot resolve goes to the approval judge (the point, why, the task and the controls the page shows), not to the owner directly;
    // a judge that asks or fails asks the owner. Payment and login fields are not this path: they always ask.
    const unknown = (why: string) => this.commit(tool, input, undefined, `the element at the point could not be identified: ${why}`, `Click at ${at} on something code could not identify\n${this.controlsSeen()}`);
    if (typeof info === "string") return unknown(info);
    if (!this.url || info.pageUrl !== this.url) return unknown("the page is not the one in the last page view");
    if (info.opaque) { // an embedded frame can hold a payment or login widget that code cannot read: the owner is asked, not the judge
      const d = unknown(info.opaque);
      return d.kind === "ask" ? { ...d, judge: false } : d;
    }
    if (info.href && info.href.split("#")[0] !== this.url.split("#")[0]) {
      const badLink = addressProblem(info.href);
      if (badLink) return this.deny(tool, input, `That link is not allowed: ${badLink}.`, { role: info.role });
    }
    const kind = info.password ? "a password" : sensitiveKind(`${info.hints} ${info.name}`) ?? (AUTOFILL_SENSITIVE.test(info.hints) ? "a payment or login detail" : undefined);
    if (kind) return this.sensitive(tool, input, [{ name: info.name || info.hints || `the field at ${at}`, kind }]);
    const node = nodeOfPoint(info, pt.x, pt.y);
    const c = classifyClick(node);
    // An empty area, or a canvas/svg/map surface with no link, button, field or form around it, is a plain click: logged with what was hit.
    this.log(tool, c.commit ? "commit-check" : "click", input, { role: node.role, name: node.name.slice(0, LIMITS.control), commit: c.commit, point: true, tag: info.tag, ...(info.nothing ? { hit: "nothing" } : {}) });
    if (c.commit) return this.commit(tool, input, node, c.why, `Click at ${at}: “${clip(node.name || "(no label)", 120)}” (${node.role})`);
    return { kind: "defer", description: `🖱️ Browser: click at ${at}: “${clip(node.name || node.role, 80)}” (${node.role})` };
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
    const done = this.doneFills(short(toolName), input);
    if (done.length) {
      // Saved details were typed: the server's echo of the typed code is dropped, the model is told only which fields were filled.
      out = out.replace(/### Ran Playwright code[\s\S]*?(?=\n### |$)/, "").replace(/\n{3,}/g, "\n\n");
      out = `Filled ${done.map((d) => `“${clip(d.label, 60)}”`).join(", ")} from the saved profile.\n${out}`;
    }
    out = cleanText(out).text; // refs and names are remembered as the model will read them, hidden characters out
    out = this.redact(out);
    if (out.length > SNAPSHOT_CAP) out = `${out.slice(0, SNAPSHOT_CAP)}\n[... ${out.length - SNAPSHOT_CAP} characters of the page view cut: use browser_find for what you need, or a narrower page]`;
    if (/\[ref=|### Snapshot|Page URL/.test(out)) audit("browse_view", "page", "browse", { tool: short(toolName), chars: out.length, cut: out.length > SNAPSHOT_CAP, fromFile: !!link });
    if (short(toolName) === "take_screenshot") audit("browse_view", "screenshot", "browse", { tool: short(toolName), chars: out.length });
    this.remember(toolName, input, out, seen);
    this.justFilled.clear();
    return out === text ? undefined : out;
  }

  remember(toolName: string, input: Record<string, unknown>, text: string, seen: string | undefined) {
    const name = short(toolName);
    if (seen && seen !== this.url) (this.typed.clear(), (this.url = seen));
    if (name === "navigate" || name === "navigate_back") this.typed.clear();
    if (/\[ref=/.test(text)) {
      const fresh = parseSnapshot(text);
      if (name === "find") for (const [k, v] of fresh) this.nodes.set(k, v);
      else (this.nodes = fresh, (this.viewUrl = this.url), (this.view = text));
    }
    if (name === "type" && isRef(input.target) && !this.justFilled.has(String(input.target))) {
      const label = this.nodes.get(String(input.target))?.name ?? "";
      this.typed.set(String(input.target), { label, value: sensitiveKind(label, String(input.text ?? "")) ? HIDDEN : String(input.text ?? "") });
    }
    if (name === "fill_form" && Array.isArray(input.fields)) for (const f of input.fields as Record<string, unknown>[]) if (isRef(f.target) && !this.justFilled.has(String(f.target))) {
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
type Block = { type?: string; text?: string; data?: string; source?: { data?: string } };
const blocksOf = (r: unknown): Block[] | undefined => (Array.isArray(r) ? (r as Block[]) : r && typeof r === "object" && Array.isArray((r as { content?: unknown }).content) ? (r as { content: Block[] }).content : undefined);
// The bytes of the first image of a tool result (base64 in the block), if any.
export function imageBytes(r: unknown): Buffer | undefined {
  const img = blocksOf(r)?.find((x) => x?.type === "image");
  const data = img?.source?.data ?? img?.data;
  return typeof data === "string" && data ? Buffer.from(data, "base64") : undefined;
}
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
