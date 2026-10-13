import net from "node:net";

// The Signal client: a JSON-RPC 2.0 connection to a running `signal-cli daemon` (one JSON object per line over
// TCP), plus the pure functions that turn what signal-cli reports into our own small types.
//   interpretEnvelope  pure: a "receive" notification -> a message or a reaction (tested without any network)
//   SignalClient       the connection: receive, send, react, read receipts, typing, group list
// Two modes, picked by the constructor (see README): Note to Self, or the assistant's own account.

// The message a reply points at (Signal's "reply" / quote).
export interface Quote {
  text: string;
  author: string;
  timestamp: number; // timestamp of the quoted message
}

// What we keep from a signal-cli "receive" notification.
export interface IncomingMessage {
  from: string; // sender's number
  text: string;
  timestamp: number;
  direct: boolean; // a one-to-one conversation with the assistant: Note to Self (self mode) or the assistant's own chat (peer mode); never a group
  fromUuid?: string; // the sender's account id, when Signal gives it
  fromName?: string; // the sender's own profile name, when Signal gives it
  group?: { id: string }; // set when the message was written in a group (own-account mode only)
  addressedToMe?: boolean; // group messages: it @mentions the assistant or replies to one of its messages
  quote?: Quote; // set when the message is a reply to an earlier one
  audio?: AudioRef; // a voice message (no text); main.ts transcribes it
  voice?: boolean; // the text is a transcript of a voice message
  image?: ImageRef; // a picture (the text is its caption, possibly empty); main.ts prepares it
}

// A voice note or audio file signal-cli has downloaded: its id names the file in its attachments folder.
export interface AudioRef {
  id: string;
  size: number;
}

export const MAX_AUDIO_BYTES = 25_000_000;

// A picture signal-cli has downloaded, named like an audio file.
export interface ImageRef {
  id: string;
  size: number;
}

export const MAX_IMAGE_BYTES = 20_000_000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];

// Pure: the first usable picture of a message, with the same rules as parseAudio. Videos and other files are skipped;
// whether the bytes really are a picture is checked when they are read (src/image.ts).
export function parseImage(attachments: unknown): ImageRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (!IMAGE_TYPES.includes(String(a?.contentType ?? "").toLowerCase()) || !/^[\w.-]{1,100}$/.test(id) || id.startsWith(".")) continue;
    if (size > 0 && size <= MAX_IMAGE_BYTES) return { id, size };
  }
  return undefined;
}

// Pure: the first usable audio attachment of a message. The id becomes a file name, so only plain
// names pass (no path separators), and huge files are refused.
export function parseAudio(attachments: unknown): AudioRef | undefined {
  if (!Array.isArray(attachments)) return undefined;
  for (const a of attachments) {
    const id = typeof a?.id === "string" ? a.id : "";
    const size = Number(a?.size ?? 0);
    if (!String(a?.contentType ?? "").startsWith("audio/") || !/^[\w.-]{1,100}$/.test(id) || id.startsWith(".")) continue;
    if (size > 0 && size <= MAX_AUDIO_BYTES) return { id, size };
  }
  return undefined;
}

// Pure: signal-cli's `quote` object -> ours. Undefined when there is nothing to show
// (a quote of an attachment-only message has no text).
export function parseQuote(raw: any): Quote | undefined {
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text) return undefined;
  return { text, author: String(raw.authorNumber ?? raw.author ?? ""), timestamp: Number(raw.id ?? 0) };
}

export interface IncomingReaction {
  from: string; // who reacted
  emoji: string;
  targetTimestamp: number; // timestamp of the message that was reacted to
  isRemove: boolean;
  direct: boolean; // as IncomingMessage.direct
  targetAuthor?: string; // who wrote the message that was reacted to
  group?: { id: string }; // set when the reaction was made in a group
  fromUuid?: string;
  fromName?: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

// Pure: a message's text with each mention (Signal puts a placeholder character there) written as @name.
export function withMentions(text: string, mentions: unknown, fallback = "someone"): string {
  const list = (Array.isArray(mentions) ? mentions : []).filter((m) => Number.isInteger(m?.start)).sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of list) if (out[m.start] === "\uFFFC") out = `${out.slice(0, m.start)}@${String(m.name ?? fallback)}${out.slice(m.start + 1)}`;
  return out;
}

export interface Channel {
  account: string; // the signal-cli account we run as
  peer?: string; // set: the assistant has its OWN account and talks to this person (peer mode). Unset: Note to Self (self mode)
  peerAci?: string; // the peer's account id, for when Signal hides their number from us
}

// Pure: what a signal-cli "receive" envelope means for us. In self mode we are the owner's linked
// device, and the owner's messages in Note to Self arrive as something THEY sent from another device.
// In peer mode we are our own account, and the owner's messages arrive as ordinary incoming ones;
// a sender is the peer only if their number (or account id) matches, and groups are never direct.
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

// Minimal JSON-RPC 2.0 client over signal-cli's TCP socket.
// Framing: one JSON object per line, in both directions.
export class SignalClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handler: ((m: IncomingMessage) => void) | undefined;
  private reactionHandler: ((r: IncomingReaction) => void) | undefined;

  // Reactions WE sent come back as incoming reactions (in Note to Self they look exactly like the
  // owner's own). Remembered for a few minutes so isOwnReaction can tell them apart.
  private ownReactions = new Map<string, number>();

  private host: string;
  private port: number;
  private account: string;
  private peer: string | undefined;
  private peerAci: string | undefined;

  // `account`: who signal-cli runs as. Without `peer`, that is the owner's own account (we are a
  // linked device and talk in Note to Self). With `peer`, it is the assistant's own account and
  // `peer` is the person it talks to.
  constructor(host: string, port: number, account: string, peer?: { number: string; aci?: string }) {
    this.host = host;
    this.port = port;
    this.account = account;
    this.peer = peer?.number;
    this.peerAci = peer?.aci;
  }

  // The groups this account is in, with who is in them (numbers and account ids).
  async groups(): Promise<{ id: string; name: string; members: { number?: string; uuid?: string }[] }[]> {
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

  get separateAccount(): boolean {
    return this.peer !== undefined;
  }

  // Tells the person we have read their message (the "seen" check under it). Own-account mode only:
  // in Note to Self there is nobody else to tell. `from` is the message's author (default: the peer);
  // in a group the receipt goes to whoever wrote it, not to the group. Best effort.
  async markRead(timestamp: number, from?: string): Promise<void> {
    if (!this.peer) return;
    try {
      await this.call("sendReceipt", { recipient: [from || this.peer], targetTimestamp: [timestamp], type: "read" });
    } catch (e) {
      console.error("read receipt failed:", (e as Error).message);
    }
  }

  // "typing…" in the chat. Only meaningful in peer mode (Signal does not show it in Note to Self).
  async typing(stop = false, groupId?: string): Promise<void> {
    if (!this.peer) return;
    try {
      await this.call("sendTyping", { ...(groupId ? { groupId } : { recipient: [this.peer] }), ...(stop ? { stop: true } : {}) });
    } catch {
      /* best effort */
    }
  }

  onMessage(handler: (m: IncomingMessage) => void) {
    this.handler = handler;
  }

  isOwnReaction(r: { emoji: string; targetTimestamp: number }): boolean {
    const key = `${r.targetTimestamp}:${r.emoji}`;
    const expires = this.ownReactions.get(key) ?? 0;
    for (const [k, e] of this.ownReactions) if (e < Date.now()) this.ownReactions.delete(k);
    return expires > Date.now();
  }

  onReaction(handler: (r: IncomingReaction) => void) {
    this.reactionHandler = handler;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("socket closed"));
        this.pending.clear();
        console.error("signal socket closed");
        process.exit(1); // launchd (later) restarts us; fail loudly for now
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
      console.error("unparseable line from signal-cli");
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
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`signal ${method} timed out after 30s`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.socket!.write(line);
    });
  }

  // Reacts to a message with an emoji. A new reaction from us on the same
  // message replaces the previous one, so this doubles as a status indicator.
  // Best-effort: a failed reaction is logged, never thrown. In a group, pass its id.
  async react(emoji: string, target: { author: string; timestamp: number }, groupId?: string): Promise<void> {
    this.ownReactions.set(`${target.timestamp}:${emoji}`, Date.now() + 5 * 60_000);
    try {
      await this.call("sendReaction", {
        ...(groupId ? { groupId } : this.to()),
        emoji,
        targetAuthor: target.author,
        targetTimestamp: target.timestamp,
      });
    } catch (e) {
      console.error(`reaction ${emoji} failed:`, (e as Error).message);
    }
  }

  // Sends a message: to our own Note to Self, or (peer mode) to the peer. Returns the sent
  // timestamp (used to ignore our own echo when it syncs back, and to match reactions).
  async send(text: string, textStyle: string[] = [], quote?: Quote, opts: { attachments?: string[]; groupId?: string } = {}): Promise<number> {
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
