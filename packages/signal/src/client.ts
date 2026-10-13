import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { silentLogger, type Logger } from "./logger.ts";

// The Signal client: a JSON-RPC 2.0 connection to a running `signal-cli daemon` (one JSON object per line over
// TCP), plus the pure functions that turn what signal-cli reports into small types of our own.
//   interpretEnvelope  pure: a "receive" notification -> a message or a reaction (testable without any network)
//   SignalClient       the connection: receive, send, react, read receipts, typing, group list
// Two modes, picked by the constructor options (see README): Note to Self, or the bot's own account.

/** The message a reply points at (Signal's "reply" / quote). */
export interface Quote {
  /** The quoted text. */
  text: string;
  /** Who wrote the quoted message (number or account id). */
  author: string;
  /** Timestamp of the quoted message. */
  timestamp: number;
}

/**
 * What the client keeps from a signal-cli "receive" notification. Text, quotes and names are untrusted input from
 * whoever wrote them; who may talk to your bot is for you to decide.
 */
export interface IncomingMessage {
  /** Sender's number (the peer's number in own-account mode when the sender is the peer). */
  from: string;
  /** The text, with @mentions written out as `@name`. Empty for an attachment-only message. */
  text: string;
  /** Signal's timestamp, which doubles as the message id. */
  timestamp: number;
  /** A private one-to-one conversation with the bot (Note to Self, or its own chat); never a group. */
  direct: boolean;
  /** The sender's account id, when Signal gives it. */
  fromUuid?: string;
  /** The sender's own profile name, when Signal gives it (groups only). */
  fromName?: string;
  /** Set when the message was written in a group (own-account mode only). */
  group?: { id: string };
  /** Group messages: it @mentions the bot or replies to one of its messages. */
  addressedToMe?: boolean;
  /** Set when the message is a reply to an earlier one. */
  quote?: Quote;
  /** A voice message or audio file (the first one); resolve its file with {@link attachmentPath}. */
  audio?: AudioRef;
  /** A picture (the first one; `text` is its caption, possibly empty); resolve its file with {@link attachmentPath}. */
  image?: ImageRef;
}

/** A voice note or audio file signal-cli has downloaded: its id names the file in its attachments folder. */
export interface AudioRef {
  id: string;
  size: number;
}

/** Audio attachments larger than this (bytes) are not surfaced. */
export const MAX_AUDIO_BYTES = 25_000_000;

/** A picture signal-cli has downloaded, named like an audio file. */
export interface ImageRef {
  id: string;
  size: number;
}

/** Pictures larger than this (bytes) are not surfaced. */
export const MAX_IMAGE_BYTES = 20_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

// An attachment id becomes a file name, so only plain names pass (no path separators, nothing hidden).
const safeId = (id: string) => /^[\w.-]{1,100}$/.test(id) && !id.startsWith(".");

/** signal-cli's folder of downloaded attachments: `$XDG_DATA_HOME` or `~/.local/share`, plus `signal-cli/attachments`. */
export function defaultAttachmentsDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "signal-cli/attachments");
}

/**
 * The file signal-cli saved for an attachment: `dir` joined with the id, after checking the id is a plain file name.
 * The content type came from the sender and the bytes are not checked here; do not follow symlinks out of `dir`.
 * @param ref an `m.audio` or `m.image`
 * @param dir signal-cli's attachments folder (default: {@link defaultAttachmentsDir})
 * @throws if the id is anything but a plain name (a path, hidden, too long)
 */
export function attachmentPath(ref: { id: string }, dir: string = defaultAttachmentsDir()): string {
  if (!safeId(ref.id)) throw new Error("not a plain attachment id");
  return join(dir, ref.id);
}

/**
 * Pure: the first usable picture among signal-cli's attachments, with the same rules as {@link parseAudio}. Videos
 * and other files are skipped; whether the bytes really are a picture is for the caller to check when it reads them.
 */
export function parseImage(attachments: unknown): ImageRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (!IMAGE_TYPES.includes(String(a?.contentType ?? "").toLowerCase()) || !safeId(id)) continue;
    if (size > 0 && size <= MAX_IMAGE_BYTES) return { id, size };
  }
  return undefined;
}

/**
 * Pure: the first usable audio attachment among signal-cli's attachments. The id becomes a file name, so only plain
 * names pass (no path separators), and files over {@link MAX_AUDIO_BYTES} are refused.
 */
export function parseAudio(attachments: unknown): AudioRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (!String(a?.contentType ?? "").startsWith("audio/") || !safeId(id)) continue;
    if (size > 0 && size <= MAX_AUDIO_BYTES) return { id, size };
  }
  return undefined;
}

/** Pure: signal-cli's `quote` object -> ours. Undefined when there is nothing to show (a quote of an attachment-only message has no text). */
export function parseQuote(raw: any): Quote | undefined {
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text) return undefined;
  return { text, author: String(raw.authorNumber ?? raw.author ?? ""), timestamp: Number(raw.id ?? 0) };
}

/** An emoji reaction somebody added to (or removed from) a message. */
export interface IncomingReaction {
  /** Who reacted. */
  from: string;
  emoji: string;
  /** Timestamp of the message that was reacted to. */
  targetTimestamp: number;
  /** True when the reaction was taken away again. */
  isRemove: boolean;
  /** As {@link IncomingMessage.direct}. */
  direct: boolean;
  /** Who wrote the message that was reacted to. */
  targetAuthor?: string;
  /** Set when the reaction was made in a group. */
  group?: { id: string };
  fromUuid?: string;
  fromName?: string;
}

/** Why the connection ended. */
export interface CloseInfo {
  /** True when {@link SignalClient.close} was called; false when signal-cli went away or the socket failed. */
  requested: boolean;
  /** The socket error behind an unrequested close, if there was one. */
  error?: Error;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Pure: a message's text with each mention (Signal puts a placeholder character there) written as `@name`. */
export function withMentions(text: string, mentions: unknown, fallback = "someone"): string {
  const list = (Array.isArray(mentions) ? mentions : []).filter((m) => Number.isInteger(m?.start)).sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of list) if (out[m.start] === "\uFFFC") out = `${out.slice(0, m.start)}@${String(m.name ?? fallback)}${out.slice(m.start + 1)}`;
  return out;
}

/** Which conversation an envelope is read for. */
export interface Channel {
  /** The signal-cli account we run as. */
  account: string;
  /** Set: the bot has its OWN account and talks to this person (peer mode). Unset: Note to Self (self mode). */
  peer?: string;
  /** The peer's account id, for when Signal hides their number from us. */
  peerAci?: string;
}

/**
 * Pure: what a signal-cli "receive" envelope means for us. In self mode we are the owner's linked device, and the
 * owner's messages in Note to Self arrive as something THEY sent from another device. In peer mode we are our own
 * account, and the owner's messages arrive as ordinary incoming ones; a sender is the peer only if their number (or
 * account id) matches, and groups are never direct. Nothing here authenticates anybody beyond that.
 */
export function interpretEnvelope(env: any, ch: Channel): { message?: IncomingMessage; reaction?: IncomingReaction } {
  if (!env) return {};
  const data = env.dataMessage;
  const sent = env.syncMessage?.sentMessage; // something WE did on another device (self mode: the phone)
  const number = env.sourceNumber ?? env.source ?? "";

  let from = number;
  let direct: boolean;
  let body = data;
  if (ch.peer !== undefined) {
    const isPeer = !!ch.peer && (number === ch.peer || (!!ch.peerAci && env.sourceUuid === ch.peerAci));
    from = isPeer ? ch.peer : number;
    direct = isPeer && !!data && !data.groupInfo;
  } else {
    const toSelf = !!sent && (sent.destinationNumber ?? sent.destination) === ch.account;
    direct = toSelf;
    body = data ?? sent;
    if (data) direct = false; // a message from someone else
  }
  if (!body) return {};
  // A group (own-account mode only; in Note to Self every group message is someone else's and ignored).
  const group = ch.peer !== undefined && data?.groupInfo?.groupId ? { id: String(data.groupInfo.groupId) } : undefined;
  if (data?.groupInfo && !group) return {};

  if (body.reaction) {
    const r = body.reaction;
    return {
      reaction: {
        from,
        emoji: String(r.emoji ?? ""),
        targetTimestamp: Number(r.targetSentTimestamp ?? 0),
        isRemove: Boolean(r.isRemove),
        direct,
        targetAuthor: r.targetAuthorNumber ?? r.targetAuthor ?? undefined,
        ...(group ? { group, fromUuid: env.sourceUuid, fromName: env.sourceName || undefined } : {}),
      },
    };
  }
  const audio = parseAudio(body.attachments);
  const image = parseImage(body.attachments);
  if (!body.message && !audio && !image) return {};
  const quote = parseQuote(body.quote);
  const mentioned = (Array.isArray(body.mentions) ? body.mentions : []).some((m: any) => m?.uuid === ch.account || m?.number === ch.account);
  return {
    message: {
      from,
      text: withMentions(body.message ?? "", body.mentions),
      timestamp: body.timestamp ?? env.timestamp,
      direct,
      quote,
      audio,
      ...(image ? { image } : {}),
      ...(group ? { group, addressedToMe: mentioned || quote?.author === ch.account, fromUuid: env.sourceUuid, fromName: env.sourceName || undefined } : {}),
    },
  };
}

/** Options of {@link SignalClient}. */
export interface SignalClientOptions {
  /** Where signal-cli's daemon listens (JSON-RPC over TCP; there is no unix-socket or stdio support). */
  host: string;
  port: number;
  /**
   * Who signal-cli runs as (a number or an account id). Without `peer`, that is the owner's own account: the client
   * is a linked device and talks in Note to Self. With `peer`, it is the bot's own account.
   */
  account: string;
  /** Set: `account` is the bot's OWN account and `peer` is the person it talks to (`aci`: their account id, for when Signal hides their number). */
  peer?: { number: string; aci?: string };
  /** Where warnings go. Default: nowhere ({@link silentLogger}). */
  logger?: Logger;
  /** How long a request may wait for its answer, in ms (default 30 000). */
  rpcTimeoutMs?: number;
  /** How long {@link SignalClient.isOwnReaction} remembers a reaction the client sent, in ms (default 300 000). */
  ownReactionMs?: number;
}

/** What {@link SignalClient.send} can carry besides the text. */
export interface SendOptions {
  /** signal-cli text styles like `"0:5:BOLD"` (start:length:STYLE). */
  style?: string[];
  /** Thread the message under an earlier one. */
  quote?: Quote;
  /** Absolute paths of files signal-cli can read. An audio file is shown as a voice message. */
  attachments?: string[];
  /** Send to this group instead of the default conversation (own-account mode). */
  groupId?: string;
}

/** A group the account is a member of. */
export interface SignalGroup {
  id: string;
  name: string;
  /** Members by phone number and/or account id, whichever Signal gives. */
  members: { number?: string; uuid?: string }[];
}

/**
 * A minimal JSON-RPC 2.0 client for signal-cli's TCP daemon (one JSON object per line in both directions).
 * Create it, register handlers, then {@link connect}. It never exits the process and installs no process handlers;
 * see {@link onClose}. There is one handler slot per kind: registering again replaces the previous handler.
 * Everything it receives is trusted to come from signal-cli; it does not decide who may talk to your bot.
 */
export class SignalClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handler: ((m: IncomingMessage) => void) | undefined;
  private reactionHandler: ((r: IncomingReaction) => void) | undefined;
  private closeHandler: ((info: CloseInfo) => void) | undefined;
  private closed = false;
  private closeRequested = false;
  private lastError: Error | undefined;

  // Reactions WE sent come back as incoming reactions (in Note to Self they look exactly like the
  // owner's own). Remembered for a few minutes so isOwnReaction can tell them apart.
  private ownReactions = new Map<string, number>();

  private host: string;
  private port: number;
  private account: string;
  private peer: string | undefined;
  private peerAci: string | undefined;
  private log: Logger;
  private rpcTimeoutMs: number;
  private ownReactionMs: number;

  constructor(opts: SignalClientOptions) {
    this.log = opts.logger ?? silentLogger;
    this.host = opts.host;
    this.port = opts.port;
    this.account = opts.account;
    this.peer = opts.peer?.number;
    this.peerAci = opts.peer?.aci;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 30_000;
    this.ownReactionMs = opts.ownReactionMs ?? 5 * 60_000;
  }

  /**
   * The groups this account is a member of, with who is in them.
   * @throws if signal-cli answers with an error or does not answer in time
   */
  async groups(): Promise<SignalGroup[]> {
    const list = await this.call<any[]>("listGroups", {});
    return (Array.isArray(list) ? list : [])
      .filter((g) => g?.isMember !== false)
      .map((g) => ({
        id: String(g.id ?? ""),
        name: String(g.name ?? ""),
        members: (Array.isArray(g.members) ? g.members : []).map((x: any) => (typeof x === "string" ? { number: x, uuid: x } : { number: x?.number ?? undefined, uuid: x?.uuid ?? undefined })),
      }));
  }

  // Where our messages go: the recipient in peer mode, our own Note to Self otherwise.
  private to(): object {
    return this.peer ? { recipient: [this.peer] } : { noteToSelf: true };
  }

  /** True in own-account mode (a `peer` was given), false in Note to Self mode. */
  get separateAccount(): boolean {
    return this.peer !== undefined;
  }

  /**
   * Tells the person we have read their message (the "seen" check under it). Own-account mode only; in Note to Self
   * there is nobody else to tell. Best effort: a failure is logged, never thrown.
   * @param timestamp the message's timestamp
   * @param from the message's author (default: the peer); in a group the receipt goes to whoever wrote it, not to the group
   */
  async markRead(timestamp: number, from?: string): Promise<void> {
    if (!this.peer) return;
    try {
      // sendReceipt takes one recipient string, not a list like send does.
      await this.call("sendReceipt", { recipient: from || this.peer, targetTimestamp: [timestamp], type: "read" });
    } catch (e) {
      this.log.warn("read receipt failed:", (e as Error).message);
    }
  }

  /**
   * Shows or clears "typing…" in the chat. Only does something in own-account mode (Signal does not show it in Note
   * to Self). Best effort: never throws.
   * @param stop true to clear the indicator
   * @param groupId type in this group instead of the peer's chat
   */
  async typing(stop = false, groupId?: string): Promise<void> {
    if (!this.peer) return;
    try {
      await this.call("sendTyping", { ...(groupId ? { groupId } : { recipient: [this.peer] }), ...(stop ? { stop: true } : {}) });
    } catch {
      /* best effort */
    }
  }

  /** Sets the handler for incoming messages (replaces the previous one). Register it before {@link connect}. */
  onMessage(handler: (m: IncomingMessage) => void) {
    this.handler = handler;
  }

  /**
   * Whether a reaction is one this client sent itself (it comes back as an incoming reaction, and in Note to Self it
   * looks exactly like the owner's own). Remembered for `ownReactionMs`.
   */
  isOwnReaction(r: { emoji: string; targetTimestamp: number }): boolean {
    const key = `${r.targetTimestamp}:${r.emoji}`;
    const expires = this.ownReactions.get(key) ?? 0;
    for (const [k, e] of this.ownReactions) if (e < Date.now()) this.ownReactions.delete(k);
    return expires > Date.now();
  }

  /** Sets the handler for incoming reactions (replaces the previous one). */
  onReaction(handler: (r: IncomingReaction) => void) {
    this.reactionHandler = handler;
  }

  /**
   * Sets the handler called once when the connection ends, whether by {@link close}, by signal-cli going away or by a
   * socket error. There is no reconnect: the host decides (exit and let a supervisor restart it, or build a new client).
   */
  onClose(handler: (info: CloseInfo) => void) {
    this.closeHandler = handler;
  }

  /** Ends the connection on purpose. Requests still waiting are rejected. Safe to call twice. */
  close() {
    this.closeRequested = true;
    this.socket?.destroy();
  }

  /**
   * Opens the connection to the daemon.
   * @throws if it cannot connect (nothing listening on host:port)
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      this.socket = socket;
      this.closed = false;
      this.closeRequested = false;
      let connected = false;
      socket.setEncoding("utf8");
      socket.once("connect", () => ((connected = true), resolve()));
      // Before connecting, an error rejects connect(); after, it is logged and the "close" that follows is reported.
      socket.on("error", (e) => {
        this.lastError = e;
        if (connected) this.log.error("signal socket error:", e.message);
        else reject(e);
      });
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("close", () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error("socket closed"));
        this.pending.clear();
        if (connected) this.closeHandler?.({ requested: this.closeRequested, error: this.closeRequested ? undefined : this.lastError });
      });
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log.warn("unparseable line from signal-cli");
      return;
    }
    // A response to one of our requests.
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "rpc error"));
      else p.resolve(msg.result);
      return;
    }
    // A pushed notification.
    if (msg.method === "receive") this.onEnvelope(msg.params?.envelope);
  }

  private onEnvelope(env: any) {
    const { message, reaction } = interpretEnvelope(env, { account: this.account, peer: this.peer, peerAci: this.peerAci });
    if (reaction) this.reactionHandler?.(reaction);
    else if (message) this.handler?.(message);
  }

  private call<T = any>(method: string, params: object): Promise<T> {
    if (!this.socket || this.closed) return Promise.reject(new Error(this.socket ? "SignalClient is closed" : "SignalClient is not connected: call connect() first"));
    const socket = this.socket;
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signal ${method} timed out after ${this.rpcTimeoutMs / 1000}s`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      socket.write(line);
    });
  }

  /**
   * Reacts to a message with an emoji. A new reaction from us on the same message replaces the previous one, so this
   * doubles as a status indicator. Best effort: a failed reaction is logged, never thrown.
   * @param target the message reacted to
   * @param groupId set when the message is in a group
   */
  async react(emoji: string, target: { author: string; timestamp: number }, groupId?: string): Promise<void> {
    this.ownReactions.set(`${target.timestamp}:${emoji}`, Date.now() + this.ownReactionMs);
    try {
      await this.call("sendReaction", {
        ...(groupId ? { groupId } : this.to()),
        emoji,
        targetAuthor: target.author,
        targetTimestamp: target.timestamp,
      });
    } catch (e) {
      this.log.warn(`reaction ${emoji} failed:`, (e as Error).message);
    }
  }

  /**
   * Sends a message: to our own Note to Self, or (own-account mode) to the peer, or to a group.
   * @returns the sent message's timestamp (use it to ignore our own echo when it syncs back, and to match reactions)
   * @throws if signal-cli refuses (bad attachment path, unknown group, ...) or does not answer in time
   */
  async send(text: string, opts: SendOptions = {}): Promise<number> {
    const { style: textStyle = [], quote } = opts;
    const result = await this.call<{ timestamp: number }>("send", {
      ...(opts.groupId ? { groupId: opts.groupId } : this.to()),
      ...(text ? { message: text } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(textStyle.length ? { textStyle } : {}),
      ...(quote ? { quoteTimestamp: quote.timestamp, quoteAuthor: quote.author, quoteMessage: quote.text } : {}),
    });
    return result.timestamp;
  }
}
