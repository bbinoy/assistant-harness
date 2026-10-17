// npm run tenants -- list | invite [note] | set-key <id> | forget-key <id>: the owner's terminal side of tenants (docs/SETUP.md "More than one person").
// Local terminal only. `set-key` is the local-only implementation of the intake (src/intake.ts): the key is typed at a hidden prompt and goes straight
// to OpenBao; it is never printed, never logged, and never goes through chat.
import { localIntake } from "../src/intake.ts";
import { readHiddenFromTerminal } from "../src/profilecli.ts";
import { tenantKeys } from "../src/secrets.ts";
import { settings } from "../src/settings.ts";
import { describeTenants } from "../src/tenanttools.ts";
import { mintInvite, tenantById } from "../src/tenants.ts";

const [cmd, arg, ...rest] = process.argv.slice(2);
const say = (l: string) => console.log(l);

if (!settings.tenants) {
  say("TENANTS is off. Set TENANTS=on in .env (and give the assistant its own Signal account) first; see docs/SETUP.md.");
  process.exit(1);
}

if (cmd === "list") {
  const lines = await describeTenants(tenantKeys);
  say(lines.length ? lines.join("\n") : "No tenants yet. Mint an invite: npm run tenants -- invite \"for Anna\" (or ask the assistant in your chat).");
} else if (cmd === "invite") {
  const made = mintInvite([arg, ...rest].filter(Boolean).join(" ") || undefined);
  say(made ? `Invite code: ${made.code}\nSingle use, valid until ${new Date(made.expiresAt).toLocaleString()}. She sends it to the assistant in a private Signal message.` : "Too many invite codes are open already.");
} else if (cmd === "set-key" && arg) {
  const r = await localIntake(arg, tenantKeys(), readHiddenFromTerminal).catch((e: Error) => ({ ok: false as const, reason: e.message }));
  say(r.ok ? `Stored ${arg}'s Anthropic API key in OpenBao (tenants/${arg}/anthropic_api_key).` : `Not stored: ${r.reason}.`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === "forget-key" && arg) {
  if (!tenantById(arg)) {
    say("No such tenant.");
    process.exit(1);
  }
  say((await tenantKeys().forget(arg)) ? `Removed ${arg}'s API key from OpenBao.` : "There was no key to remove.");
} else {
  say("usage: npm run tenants -- list | invite [note] | set-key <id> | forget-key <id>");
  process.exit(1);
}
