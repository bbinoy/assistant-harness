import { createServer } from "node:net";

// What is under a point of the page: a lookup owned by CODE, never by the model (the vision-click experiment, BROWSE_VISION=click).
// The browser is asked over its own debugging port (loopback, a random port, only while a click-mode run lives; browseserver.ts). The
// answer comes from the browser's hit test (DOM.getNodeForLocation: the same test a real click goes through, so an overlay on top counts),
// the browser's own accessible role and name (the accessibility tree) and a fixed function run in an ISOLATED world (a hostile page cannot
// patch the functions it uses). The page's own scripts are never asked anything.

export interface PointInfo {
  pageUrl: string; // the page address the lookup was made on
  role: string; // the nearest interactive role from the point upwards, else "generic"
  name: string; // its accessible name, else the text at the point
  tag: string;
  href: string; // a link around the point (it is followed by a click), else ""
  inForm: boolean;
  formName: string;
  hints: string; // name, id, autocomplete, type, placeholder, label of the element at the point: what kind of field it is
  password: boolean; // an input of type password
  opaque?: string; // what the point is, when code cannot read what a click there does (canvas, embedded frame, video...)
}

export type Probe = (x: number, y: number) => Promise<PointInfo | string>; // a string: why the point could not be resolved

export interface Cdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, any>>; // rejects on a protocol error
}

const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "slider", "spinbutton", "listbox", "treeitem", "DisclosureTriangle", "PopUpButton", "ComboBoxSelect", "TextField"]);
const OPAQUE = new Set(["canvas", "iframe", "frame", "embed", "object", "video", "audio"]);

// Fixed. Runs in an isolated world on the element under the point (`this`).
const DESCRIBE = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (!el) return null;
  const a = el.closest("a[href]");
  const f = el.closest("form");
  const at = (n) => el.getAttribute(n) || "";
  return {
    tag: el.tagName.toLowerCase(),
    type: at("type").toLowerCase(),
    hints: [at("name"), el.id, at("autocomplete"), at("type"), at("placeholder"), at("aria-label")].filter(Boolean).join(" "),
    href: a ? a.href : "",
    inForm: !!f,
    formName: f ? (f.getAttribute("aria-label") || f.getAttribute("name") || f.id || "") : "",
  };
}`;

interface AxNode { nodeId: string; parentId?: string; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; ignored?: boolean }

// Resolve the point on an open session. Pure apart from the calls on `cdp`.
export async function describePoint(cdp: Cdp, x: number, y: number, pageUrl: string): Promise<PointInfo | string> {
  try {
    await cdp.send("DOM.enable");
    await cdp.send("DOM.getDocument", { depth: 0 });
    const hit = await cdp.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
    const backendNodeId = hit.backendNodeId as number | undefined;
    if (typeof backendNodeId !== "number") return "the browser found no element at that point";

    const ax = ((await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true })).nodes ?? []) as AxNode[];
    const self = ax.find((n) => n.backendDOMNodeId === backendNodeId);
    const byId = new Map(ax.map((n) => [n.nodeId, n]));
    const chain: AxNode[] = [];
    for (let n = self, i = 0; n && i < 40; n = n.parentId ? byId.get(n.parentId) : undefined, i++) chain.push(n);
    const interactive = chain.find((n) => INTERACTIVE.has(n.role?.value ?? ""));
    const text = self ? ax.filter((n) => n.parentId === self.nodeId && n.role?.value === "StaticText").map((n) => n.name?.value ?? "").join(" ").trim() : "";
    const role = interactive?.role?.value ?? "generic";
    const name = (interactive?.name?.value ?? text ?? "").trim();

    const world = await cdp.send("Page.createIsolatedWorld", { frameId: hit.frameId, worldName: "ted-guard" });
    const node = await cdp.send("DOM.resolveNode", { backendNodeId, executionContextId: world.executionContextId });
    const ran = await cdp.send("Runtime.callFunctionOn", { objectId: node.object?.objectId, functionDeclaration: DESCRIBE, returnByValue: true });
    const d = ran.result?.value as { tag: string; type: string; hints: string; href: string; inForm: boolean; formName: string } | null | undefined;
    if (!d || typeof d.tag !== "string") return "the element at that point could not be described";

    return {
      pageUrl,
      role,
      name,
      tag: d.tag,
      href: d.href,
      inForm: d.inForm,
      formName: d.formName,
      hints: d.hints,
      password: d.type === "password",
      ...(OPAQUE.has(d.tag) ? { opaque: d.tag === "canvas" ? "a canvas (drawn by the page; code cannot read what a click there does)" : d.tag === "iframe" || d.tag === "frame" ? "an embedded frame (payment and login widgets live in one)" : `an embedded ${d.tag}` } : {}),
    };
  } catch (e) {
    return `the lookup failed (${String((e as Error)?.message ?? e).slice(0, 80)})`;
  }
}

// ---- the connection (the only part that talks to a real browser) ----

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)))]).finally(() => clearTimeout(t));
};

// A session on the one open page. More or fewer than one page: the point cannot be tied to the page the worker sees, so no answer.
export async function openSession(port: number, timeoutMs = 4000): Promise<{ cdp: Cdp; pageUrl: string; close: () => void } | string> {
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })).json()) as { type: string; url: string; webSocketDebuggerUrl?: string }[];
    const pages = list.filter((t) => t.type === "page");
    if (pages.length !== 1 || !pages[0]!.webSocketDebuggerUrl) return pages.length === 0 ? "no page is open" : `${pages.length} tabs are open, so which one is shown is not certain`;
    const ws = new WebSocket(pages[0]!.webSocketDebuggerUrl);
    await withTimeout(new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("connection failed"))))), timeoutMs, "connect");
    let id = 0;
    const pending = new Map<number, { res: (v: Record<string, any>) => void; rej: (e: Error) => void }>();
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, any>; error?: { message?: string } };
      const p = m.id !== undefined ? pending.get(m.id) : undefined;
      if (!p || m.id === undefined) return;
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message ?? "protocol error"));
      else p.res(m.result ?? {});
    };
    const send: Cdp["send"] = (method, params = {}) => withTimeout(new Promise((res, rej) => (pending.set(++id, { res, rej }), ws.send(JSON.stringify({ id, method, params })))), timeoutMs, method);
    return { cdp: { send }, pageUrl: pages[0]!.url, close: () => ws.close() };
  } catch (e) {
    return `the browser could not be reached (${String((e as Error)?.message ?? e).slice(0, 80)})`;
  }
}

// A free loopback port for the browser's debugging port (picked just before the browser starts).
export const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

export const cdpProbe = (port: number): Probe => async (x, y) => {
  const s = await openSession(port);
  if (typeof s === "string") return s;
  try {
    return await describePoint(s.cdp, x, y, s.pageUrl);
  } finally {
    s.close();
  }
};
