// Starts `signal-cli daemon` on localhost, so the client has something to connect to.
import { spawn } from "node:child_process";
import net from "node:net";
import { silentLogger, type Logger } from "./logger.ts";

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

// A running daemon, as ensureSignalDaemon reports it.
export interface SignalDaemon {
  started: boolean; // false: one was already listening and we reuse it (we do not own it, stop() does nothing)
  stop(): void; // asks the daemon we started to quit (SIGTERM); does nothing for a reused one
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; // settles when the daemon we started exits; never settles for a reused one
}

// Makes sure a signal-cli daemon is listening, starting it if needed. Installs no process handlers and never exits
// the process: what to do when the daemon dies (restart, exit, ...) and when to stop it is the caller's decision.
// `logFd`: where the daemon's output goes (a file descriptor opened for appending); default: discarded.
export async function ensureSignalDaemon(account: string, host: string, port: number, logFd?: number, log: Logger = silentLogger): Promise<SignalDaemon> {
  if (await portOpen(host, port)) {
    log.info("signal-cli daemon already running, reusing it");
    return { started: false, stop() {}, exited: new Promise(() => {}) };
  }
  const out = logFd ?? "ignore";
  // The socket is unauthenticated: anything that can reach it can send as the account, so keep host on this machine.
  const child = spawn("signal-cli", ["-a", account, "daemon", "--tcp", `${host}:${port}`, "--no-receive-stdout"], {
    stdio: ["ignore", out, out],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null })); // could not be started at all (not installed)
  });
  let gone = false;
  void exited.then(() => (gone = true));
  const daemon: SignalDaemon = { started: true, stop: () => void child.kill("SIGTERM"), exited };

  for (let i = 0; i < 60; i++) {
    if (await portOpen(host, port)) {
      log.info("signal-cli daemon started");
      return daemon;
    }
    if (gone) throw new Error("signal-cli exited before it opened its port");
    await new Promise((r) => setTimeout(r, 500));
  }
  daemon.stop();
  throw new Error("signal-cli did not open its port within 30s");
}
