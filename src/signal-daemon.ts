import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import net from "node:net";

function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

// Makes sure a signal-cli daemon is listening, starting and supervising it if needed.
// If the child ever dies we exit too, so launchd restarts the whole agent cleanly
// instead of leaving a harness with no Signal connection.
export async function ensureSignalDaemon(account: string, host: string, port: number): Promise<void> {
  if (await portOpen(host, port)) {
    console.log("signal-cli daemon already running, reusing it");
    return;
  }
  const log = openSync(new URL("../state/signal-daemon.log", import.meta.url), "a");
  // 127.0.0.1 only: the socket is unauthenticated, anything that can reach it can send as you.
  const child = spawn("signal-cli", ["-a", account, "daemon", "--tcp", `${host}:${port}`, "--no-receive-stdout"], {
    stdio: ["ignore", log, log],
  });
  child.once("exit", (code, sig) => {
    console.error(`signal-cli exited (code=${code} signal=${sig}); exiting so launchd restarts us`);
    process.exit(1);
  });
  const stop = () => child.kill("SIGTERM");
  process.once("exit", stop);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => (stop(), process.exit(0)));

  for (let i = 0; i < 60; i++) {
    if (await portOpen(host, port)) {
      console.log("signal-cli daemon started");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("signal-cli did not open its port within 30s");
}
