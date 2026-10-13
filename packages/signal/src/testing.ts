import net from "node:net";

// Test helpers for code that uses SignalClient: a fake signal-cli daemon, so a test talks to a real socket
// without Signal. It speaks the same line-delimited JSON-RPC, records what the client sends, answers as the
// test says, and can push what signal-cli would push (incoming messages) or misbehave (partial lines, hang up).

export interface FakeRequest {
  id: number;
  method: string;
  params: any;
}

// Returned from an answer function to make the request fail with this message, like signal-cli's JSON-RPC error.
export class FakeRpcError {
  message: string;
  constructor(message: string) {
    this.message = message;
  }
}

// What to answer a request with: a result, a FakeRpcError, or undefined to leave it unanswered (the test answers
// later with reply(), or never, to exercise timeouts and a hang-up with a request in flight).
export type FakeAnswer = (req: FakeRequest) => unknown;

let counter = 1;
const defaultAnswer: FakeAnswer = (r) => (r.method === "send" ? { timestamp: 1_000_000 + counter++ } : {});

export class FakeSignalDaemon {
  readonly requests: FakeRequest[] = [];
  readonly host = "127.0.0.1";
  port = 0;
  answer: FakeAnswer;
  private sockets = new Set<net.Socket>();
  private server: net.Server;

  private constructor(answer: FakeAnswer) {
    this.answer = answer;
    this.server = net.createServer((s) => this.onConnection(s));
  }

  // Listens on a free port of 127.0.0.1.
  static async start(answer: FakeAnswer = defaultAnswer): Promise<FakeSignalDaemon> {
    const d = new FakeSignalDaemon(answer);
    await new Promise<void>((resolve) => d.server.listen(0, d.host, resolve));
    d.port = (d.server.address() as net.AddressInfo).port;
    return d;
  }

  private onConnection(s: net.Socket) {
    this.sockets.add(s);
    s.setEncoding("utf8");
    let buf = "";
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as FakeRequest;
        this.requests.push(req);
        const result = this.answer(req);
        if (result !== undefined) this.reply(req.id, result);
      }
    });
    s.on("error", () => {});
    s.on("close", () => this.sockets.delete(s));
  }

  // Number of clients connected right now. A client's connect() resolves slightly before the server sees it:
  // wait for this to be above 0 before pushing.
  get connections(): number {
    return this.sockets.size;
  }

  // Answers a request (by id) with a result or a FakeRpcError.
  reply(id: number, result: unknown) {
    const body = result instanceof FakeRpcError ? { error: { code: -1, message: result.message } } : { result };
    this.raw(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
  }

  // Pushes a "receive" notification carrying this signal-cli envelope.
  push(envelope: object) {
    this.raw(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope } }) + "\n");
  }

  // Writes bytes as they are: for split lines, several lines in one chunk, or garbage.
  raw(text: string) {
    for (const s of this.sockets) s.write(text);
  }

  // Hangs up on every client but keeps listening.
  dropConnections() {
    for (const s of this.sockets) s.destroy();
  }

  async close(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
