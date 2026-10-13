// One spare ("warm") Claude Code process, built ahead of time for the next message of ONE conversation (agent.ts).
// It is a slot, not a pool: putting another process in closes the one it replaces, so a slot never holds more than one.
// The owner's chat has its own slot (refreshed by a timer in main.ts). Groups share a second slot, for the group that
// spoke last: another group becoming the latest replaces it, and it is dropped when nothing has used it for `idleMs`.
// A spare is built from ONE conversation's options, so it is handed out only for the same id and the same key (session,
// prompt, memory index), and never to another conversation.

export interface Closeable {
  close(): void;
}

export interface SlotOptions {
  maxAgeMs: number; // older than this when asked for: not used
  idleMs?: () => number; // dropped this long after it was last put in (0 or unset: kept until replaced or too old)
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void; // returns its cancel (tests)
}

const unrefTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export class SpareSlot<W extends Closeable> {
  #cur?: { id: string; key: string; at: number; warm: Promise<W> };
  #cancelIdle?: () => void;
  readonly #o: SlotOptions;

  constructor(o: SlotOptions) {
    this.#o = o;
  }

  #now = () => (this.#o.now ?? Date.now)();

  // Which conversation the spare is for, if there is one (for logs and tests).
  get holder(): string | undefined {
    return this.#cur?.id;
  }

  // Is there a fresh spare for this conversation already?
  has(id: string): boolean {
    const c = this.#cur;
    return !!c && c.id === id && this.#now() - c.at < this.#o.maxAgeMs;
  }

  // Keep this warm process as the spare, closing the one it replaces. A process that fails to start empties the slot.
  put(id: string, key: string, warm: Promise<W>): void {
    this.drop();
    const entry = { id, key, at: this.#now(), warm };
    this.#cur = entry;
    warm.catch(() => {
      if (this.#cur === entry) this.drop();
    });
    this.#armIdle();
  }

  // The conversation is still active: start its idle period over. No-op for a spare that is not this conversation's.
  touch(id: string): void {
    if (this.has(id)) this.#armIdle();
  }

  #armIdle(): void {
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
    const idle = this.#o.idleMs?.() ?? 0;
    if (idle > 0) this.#cancelIdle = (this.#o.schedule ?? unrefTimer)(() => this.drop(), idle);
  }

  // The spare, if it was built for exactly this conversation and state and is fresh. A spare serves one query, so it leaves the
  // slot; one of the same conversation that no longer fits (session moved on, too old) is closed. One of another conversation
  // is left alone: that conversation's own turn replaces it when it is done.
  take(id: string, key: string): Promise<W> | undefined {
    const c = this.#cur;
    if (!c || c.id !== id) return undefined;
    this.#clear();
    if (c.key === key && this.#now() - c.at < this.#o.maxAgeMs) return c.warm;
    c.warm.then((w) => w.close()).catch(() => {});
    return undefined;
  }

  drop(): void {
    const c = this.#cur;
    this.#clear();
    c?.warm.then((w) => w.close()).catch(() => {});
  }

  #clear(): void {
    this.#cur = undefined;
    this.#cancelIdle?.();
    this.#cancelIdle = undefined;
  }
}
