// `npm run signal:groups`: lists the Signal groups the assistant's account is in, with the id to put in
// SIGNAL_GROUPS (a comma-separated list) to let it take part. Needs the agent running (own-account mode).
import { SignalClient } from "@ted-personal-assistant/signal";
import { config } from "../src/config.ts";
import { settings } from "../src/settings.ts";

if (config.signalAccount === config.ownerNumber) {
  console.error("Groups need the assistant's own Signal account (SIGNAL_ACCOUNT). See docs/SIGNAL-ACCOUNT.md.");
  process.exit(1);
}
const signal = new SignalClient(settings.signalHost, settings.signalPort, config.signalAccount, { number: config.ownerNumber, aci: config.ownerAci });
await signal.connect();
const groups = await signal.groups();
if (groups.length === 0) console.log("The assistant is not in any group yet. Add it to one in Signal (by its name or username), then run this again.");
for (const g of groups) console.log(`${settings.signalGroups.includes(g.id) ? "✓ listed " : "  not listed"}  ${g.name || "(no name)"}\n             SIGNAL_GROUPS=${g.id}`);
process.exit(0);
