# Give the assistant its own Signal account

By default you chat with the assistant in **Note to Self**: it is a linked device of *your* account, so every message, yours and its, appears to come from you. That works, but it is hard to feel you are talking to someone. With its own Signal account the assistant is a separate contact with its own name and picture, "typing…" shows while it works, and the conversation reads like a chat.

Everything else is identical (approvals, reactions, quote-replies, voice notes, the message log). Note to Self stays the default; this is opt-in, and removing `SIGNAL_ACCOUNT` from `.env` takes you back.

## 1. Create the account

You need a Signal account that is **not yours**. Two ways:

**A. A spare phone number** (the simplest and most reliable). A prepaid SIM or eSIM is enough; Signal only needs it once, to send a code.

```bash
signal-cli -a +10000000001 register            # add --voice if SMS does not arrive
# if Signal asks for a captcha: open https://signalcaptchas.org/registration/generate.html,
# solve it, copy the "signalcaptcha://..." link and add:  --captcha 'signalcaptcha://...'
signal-cli -a +10000000001 verify 123456       # the code you received
```

**B. Signal Login, no phone number** (a beta feature of Signal for Android; a one-time in-app purchase of about $3, price varies by country). Install the Signal beta on an Android device, choose to register without a phone number, and keep the Account ID and Account Key it shows you somewhere safe (there is no recovery). signal-cli cannot register such an account by itself, but it can take one over with the recovery key from the Android app:

```bash
signal-cli -a ACCOUNT_KEY register --recovery-key RECOVERY_KEY
```

The recovery key is the 64-character key under Signal's Settings → Backups, and the account key is shown under Settings → Account. Type them into a terminal prompt rather than pasting them anywhere shared, for example `read -s "?Recovery key: " RK` then `signal-cli -a "$ACCOUNT" register --recovery-key "$RK"`. This logs the Android app out; signal-cli becomes the account's device (so the phone can be wiped afterwards). The exact steps follow signal-cli's current documentation and issue [#2124](https://github.com/AsamK/signal-cli/issues/2124); both Signal Login and this flow are new, so check there if something differs.

## 2. Give it a name (and optionally a username)

```bash
signal-cli -a ACCOUNT updateProfile --given-name "Ted" --avatar assets/ted.png   # run it BEFORE step 3: once the assistant is running, signal-cli holds the account and a second command would hang
signal-cli -a ACCOUNT updateAccount -u tedassistant      # optional: you can then find it by username
```

`ACCOUNT` is the number from A, or the account key from B. `assets/ted.png` is a sample avatar (original artwork, free to use); any square picture works.

## 3. Switch the assistant over

In `.env`:

```
SIGNAL_OWNER_NUMBER=+10000000000     # you, as before
SIGNAL_ACCOUNT=+10000000001          # the assistant (number, or the account key from B)
```

Restart the agent (`launchctl kickstart -k gui/$(id -u)/<your LAUNCHD_LABEL>`, or `npm run daemon` again) and check `npm run doctor` says it is using the assistant's own account. Then start the chat:

```bash
npm run signal:hello
```

The assistant sends you a first message. On your phone it shows up as a message request from the assistant's profile name; accept it and say hi. (An account without a phone number cannot be found by number; if you gave it a username in step 2, you can also search for that.)

## Group chats

With its own account the assistant can be added to a Signal group and take part. It is deliberately a different, much more limited assistant there, because other people write to it:

1. Add it to the group in Signal (by its name or username), then run `npm run signal:groups` on the Mac. It lists the groups it is in, each with the line to put in `.env`: `SIGNAL_GROUPS=<id>` (several ids, comma-separated). Restart it.
2. It answers **only** when someone @mentions it or replies to one of its messages, in a group you listed. Any other group, and any other message, is ignored.
3. In a group it has **no access to your mail, calendar, tasks or notes**, will not talk about anything private (even if you ask: do that in your own chat), and has web search only. What people write there is text it responds to, never instructions that change its rules.
4. Nothing from a group is saved: no memory notes, no message log, and the nightly dream never sees it. The few recent messages it needs for context are held in memory and are gone when it restarts. It answers at most `GROUP_REPLIES_PER_HOUR` times per group (default 12).

## If it does not answer

The assistant only acts on a direct message from your number. If Signal hides your number from it (your privacy setting "Who can see my number" is *Nobody* and you are not in its contacts), the message arrives with only your account id and is ignored. Fix: look the id up and put it in `.env`:

```bash
signal-cli -a ACCOUNT listContacts          # or check the daemon log
# SIGNAL_OWNER_ACI=<your account id (a UUID)>
```

Only that exact id is trusted, and only for direct messages; groups are never accepted.
