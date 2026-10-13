# Setting up signal-cli for a bot

This package talks to [signal-cli](https://github.com/AsamK/signal-cli), which you install and register yourself (see "Third-party software" in the README). Two ways to use it:

- **Note to Self.** The bot is a linked device of *your* Signal account and talks in your Note to Self chat. Nothing to create, but every message looks like it comes from you.
- **Its own account.** The bot is a separate Signal account with its own name and picture; you chat with it like with a contact, "typing…" and read receipts work, and it can join groups. This page shows how to create one.

signal-cli needs a Java runtime (check its README for the version your release wants). The field names this package reads (`sourceNumber`, `destinationNumber`, `targetSentTimestamp`, `groupInfo`, text style strings) follow signal-cli's JSON-RPC output and have shifted between signal-cli versions: see "Tested with" in the README.

## Note to Self: link signal-cli to your account

```bash
signal-cli link -n "my bot"      # prints a tsdevice:/ link; make a QR code of it (for example with `qrencode -t ansiutf8`)
```

On your phone: Signal → Settings → Linked devices → add a device → scan the code. Then use your own number as `account` and give no `peer`.

## Its own account

You need a Signal account that is **not yours**. Two ways:

**A. A spare phone number** (the simplest and most reliable). A prepaid SIM or eSIM is enough; Signal only needs it once, to send a code.

```bash
signal-cli -a +10000000001 register            # add --voice if SMS does not arrive
# if Signal asks for a captcha: open https://signalcaptchas.org/registration/generate.html,
# solve it, copy the "signalcaptcha://..." link and add:  --captcha 'signalcaptcha://...'
signal-cli -a +10000000001 verify 123456       # the code you received
```

**B. Signal Login, no phone number** (a feature of Signal for Android that may still change). Follow signal-cli's current documentation for taking over such an account; it is new, so check there if something differs. An account without a phone number cannot be found by number, so the bot's first message to you needs a username or a link (see below).

Give it a name (and optionally a username), **before** the daemon runs: once the daemon holds the account, a second signal-cli command on the same account would hang.

```bash
signal-cli -a ACCOUNT updateProfile --given-name "My Bot" --avatar bot.png
signal-cli -a ACCOUNT updateAccount -u mybot      # optional: you can then find it by username
```

`ACCOUNT` is the number from A, or the account key from B. Use it as `account`, and your own number as `peer.number`.

The first message has to come from the bot: `new SignalClient({ ..., peer: { number: you } }).send("hi")`. On your phone it shows up as a message request from the bot's profile name; accept it.

## Groups

With its own account the bot can be added to a Signal group. A group message has `group: { id }` and `direct: false`; `addressedToMe` is true when it @mentions the bot or replies to one of its messages. `client.groups()` lists the groups with their members, so you can act only in groups you trust. The package never decides who may talk to your bot.

## If the bot does not answer

If a person's Signal privacy setting "Who can see my number" is *Nobody* (and the bot is not in their contacts), their messages arrive with only their account id, not their number. Pass it as `peer: { number, aci }` so the client still recognises them. Find the id with `signal-cli -a ACCOUNT listContacts` or in the daemon log. Only that exact id is accepted, and only for direct messages.
