import net from "node:net";

// What we keep from a signal-cli "receive" notification.
export interface IncomingMessage {
  from: string; // sender's number
  text: string;
  timestamp: number;
  noteToSelf: boolean; // sent by us from another device, addressed to ourselves
}

export interface IncomingReaction {
  from: string; // who reacted
  emoji: string;
  targetTimestamp: number; // timestamp of the message that was reacted to
  isRemove: boolean;
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
  private loggedReactionShape = false;

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
    // A reaction: either from someone else (dataMessage) or one we made on another
    // device (syncMessage.sentMessage), which is how reactions from our own phone arrive.
    const reaction = env.dataMessage?.reaction ?? env.syncMessage?.sentMessage?.reaction;
    if (reaction) {
      if (!this.loggedReactionShape) {
        this.loggedReactionShape = true;
        console.log(`reaction envelope fields: ${Object.keys(reaction).join(", ")}`); // names only, once
      }
      this.reactionHandler?.({
        from: env.sourceNumber ?? env.source ?? "",
        emoji: String(reaction.emoji ?? ""),
        targetTimestamp: Number(reaction.targetSentTimestamp ?? reaction.targetTimestamp ?? 0),
        isRemove: Boolean(reaction.isRemove ?? reaction.remove),
      });
      return;
    }
    // Normal inbound message from someone else.
    if (env.dataMessage?.message) {
      this.handler?.({
        from: env.sourceNumber ?? env.source ?? "",
        text: env.dataMessage.message,
        timestamp: env.dataMessage.timestamp ?? env.timestamp,
        noteToSelf: false,
      });
      return;
    }
    // Something WE sent from another device (our phone), synced to this device.
    // Note to Self arrives this way: sender == destination == our own number.
    const sent = env.syncMessage?.sentMessage;
    if (sent?.message) {
      this.handler?.({
        from: env.sourceNumber ?? env.source ?? "",
        text: sent.message,
        timestamp: sent.timestamp ?? env.timestamp,
        noteToSelf: (sent.destinationNumber ?? sent.destination) === this.account,
      });
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

  // Sends to our own Note to Self. Returns the sent timestamp (used to ignore
  // our own echo when it syncs back).
  async sendNoteToSelf(text: string, textStyle: string[] = []): Promise<number> {
    const result = await this.call<{ timestamp: number }>("send", {
      noteToSelf: true,
      message: text,
      ...(textStyle.length ? { textStyle } : {}),
    });
    return result.timestamp;
  }
}
