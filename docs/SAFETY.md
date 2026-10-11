# Safety model

The agent can read your mail and act on your behalf, so most of the design is about limiting what it can do and making everything it does visible and reversible.

| Layer | What it does |
|---|---|
| Owner allowlist | Only your own *Note to Self*, from your own number, is ever acted on. Your linked device also receives all your other Signal traffic; it is dropped and logged with a masked number. (`guards.ts`, tested) |
| Tool policy | allow / ask / deny in `policy.ts`, tested against real tool names. Unknown tools default to *ask*. What may run unattended depends on who is acting: the background mail handler, which reads untrusted mail with nobody watching, may only leave reply drafts. No tool input may reference a local file (`file://`), so an injected email cannot get `~/.ssh` or `.env` attached to a draft. |
| Approvals | The question is built from the exact arguments, never paraphrased by a model, and nothing is cut silently: a long email body is shown generously and any remainder is announced. Fail closed: a timeout or any doubt means *no*. Edit-and-approve is limited to calendar create/update, never to recipients or attendees. A model judge for free-text replies returns constrained output; a rambling answer cannot become an approval. |
| Reversible by default | Mail is only archived (never deleted), every archive is recorded with ids, and `npm run restore <id>` brings it back. At most 25 archives per tick. |
| Memory | Only you can change it: from chat, with an approval on your phone for every change. The brief, the mail handler and the heartbeat are denied the memory tools outright, so a hostile email cannot plant a rule. Memory is injected as fenced data and can shape tone, priorities and sorting but never permissions: policy and the protected-mail guard are code. Changes are audited by category and decision, never by content. |
| Spend guard | A daily ceiling pauses *background* work (brief retries, the handler); chat stays available. |
| Robust state | State files are written atomically and updated synchronously: no torn files after a crash, no lost updates between concurrent parts. Settings are validated at startup, so a typo stops the agent instead of misconfiguring it. |
| Observability | `logs/audit.jsonl` records every tool decision (ids, never email content, for chat). `logs/agent.log` is redacted (numbers, tokens) and rotated. `npm run report` shows what the heartbeat did, `npm run triage-check` shows what it *would* do with your newest mail without acting, and `npm run doctor` warns if the heartbeat has stopped ticking. |
| Kill switches | `touch state/paused` pauses everything (put a date inside to resume on it). `HEARTBEAT_ACTIONS=log` makes the heartbeat record decisions without acting. |

Known limits: `signal-cli` stores its keys unencrypted on disk (keep FileVault on); its local socket is unauthenticated (it listens on `127.0.0.1` only); anything running as your user can reach it. Prompt injection cannot be solved, only contained: the design above limits what a hostile email can make the agent do, it does not make it impossible to try.

Back to the [README](../README.md) · [Setup](SETUP.md) · [Architecture](ARCHITECTURE.md) · [Adapting](ADAPTING.md)
