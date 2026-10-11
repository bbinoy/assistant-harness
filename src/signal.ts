import net from "node:net";

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
  noteToSelf: boolean; // sent by us from another device, addressed to ourselves
  quote?: Quote; // set when the message is a reply to an earlier one
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
  noteToSelf: boolean; // made by us from another device, in our own Note to Self
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

// Minimal JSON-RPC 2.0 client over signal-cli's TCP socket.
// Framing: one JSON object per line, in both directions.
export class SignalClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handler: ((m: IncomingMessage) => void) | undefined;
  private reactionHandler: ((r: IncomingReaction) => void) | undefined;

  private host: string;
  private port: number;
  private account: string;

  constructor(host: string, port: number, account: string) {
    this.host = host;
    this.port = port;
    this.account = account;
  }

  onMessage(handler: (m: IncomingMessage) => void) {
    this.handler = handler;
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
    if (!env) return;
    const from = env.sourceNumber ?? env.source ?? "";
    const sent = env.syncMessage?.sentMessage; // something WE did on another device (our phone)
    const toSelf = !!sent && (sent.destinationNumber ?? sent.destination) === this.account;

    // A reaction: from someone else (dataMessage), or ours from the phone (sentMessage).
    const reaction = env.dataMessage?.reaction ?? sent?.reaction;
    if (reaction) {
      this.reactionHandler?.({
        from,
        emoji: String(reaction.emoji ?? ""),
        targetTimestamp: Number(reaction.targetSentTimestamp ?? 0),
        isRemove: Boolean(reaction.isRemove),
        noteToSelf: !env.dataMessage?.reaction && toSelf,
      });
      return;
    }
    // A message from someone else.
    if (env.dataMessage?.message) {
      this.handler?.({ from, text: env.dataMessage.message, timestamp: env.dataMessage.timestamp ?? env.timestamp, noteToSelf: false, quote: parseQuote(env.dataMessage.quote) });
      return;
    }
    // A message we sent from the phone. Note to Self arrives this way (destination == us).
    if (sent?.message) {
      this.handler?.({ from, text: sent.message, timestamp: sent.timestamp ?? env.timestamp, noteToSelf: toSelf, quote: parseQuote(sent.quote) });
    }
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
  // Best-effort: a failed reaction is logged, never thrown.
  async react(emoji: string, target: { author: string; timestamp: number }): Promise<void> {
    try {
      await this.call("sendReaction", {
        noteToSelf: true,
        emoji,
        targetAuthor: target.author,
        targetTimestamp: target.timestamp,
      });
    } catch (e) {
      console.error(`reaction ${emoji} failed:`, (e as Error).message);
    }
  }

  // The "typing..." indicator. Signal shows it for about 15 seconds, so it has to be renewed.
  // Best-effort: a failure is never worth interrupting a reply for.
  async typing(on: boolean): Promise<void> {
    try {
      await this.call("sendTyping", { recipient: [this.account], ...(on ? {} : { stop: true }) });
    } catch (e) {
      console.error("typing indicator failed:", (e as Error).message);
    }
  }

  // Sends to our own Note to Self. Returns the sent timestamp (used to ignore
  // our own echo when it syncs back).
  async sendNoteToSelf(text: string, textStyle: string[] = [], quote?: Quote): Promise<number> {
    const result = await this.call<{ timestamp: number }>("send", {
      noteToSelf: true,
      message: text,
      ...(textStyle.length ? { textStyle } : {}),
      ...(quote ? { quoteTimestamp: quote.timestamp, quoteAuthor: quote.author, quoteMessage: quote.text } : {}),
    });
    return result.timestamp;
  }
}
