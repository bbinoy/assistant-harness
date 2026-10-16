// npm run card -- set|list|enable|disable|delete|payments|clear: the owner's payment card for the browse worker (src/cardcli.ts). Local terminal only.
import { CardStore, killSwitch } from "../src/card.ts";
import { cardCli } from "../src/cardcli.ts";
import { Ledger } from "../src/payments.ts";
import { readHiddenFromTerminal } from "../src/profilecli.ts";

try {
  process.exit(await cardCli(process.argv.slice(2), { store: new CardStore(), kill: killSwitch, ledger: new Ledger(), readHidden: readHiddenFromTerminal, out: (l) => console.log(l) }));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
