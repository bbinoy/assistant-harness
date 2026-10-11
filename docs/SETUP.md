# Setup

## Status and limits

This is a personal project that runs daily for its author. It works, its safety-critical logic is unit-tested, and it is opinionated. It is **macOS only**, built for **one user**, and it works only while your Mac is awake. Read the code before trusting it with your inbox, and check Anthropic's current terms for using your plan this way.

## Requirements

- **macOS** (launchd supervises the agent; Mailbird is the mail client). Linux would work for everything except those two.
- **Node 24+** (TypeScript runs directly, there is no build step).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/overview)** installed and logged in (`claude auth login`). The agent uses your stored login so it can reach your claude.ai connectors (Notion, Google Calendar, Gmail…). *Check Anthropic's current terms for using your plan for personal automation like this.* An API key or `claude setup-token` also work but cannot use those connectors (see `HARNESS_AUTH` in `.env.example`).
- **[signal-cli](https://github.com/AsamK/signal-cli)** (`brew install signal-cli`), linked to your Signal account as a secondary device.
- **A mail client with an MCP server.** This repo uses [Mailbird](https://www.getmailbird.com/); see [Why a local mail client](ADAPTING.md#why-the-default-is-a-local-client) and [ADAPTING.md](ADAPTING.md) if you use Gmail only.
- Optional: Notion and Google Calendar connected under *claude.ai → Settings → Connectors*, for the task and calendar parts of the brief.

## Install

```bash
git clone https://github.com/<you>/number-one && cd number-one
npm install

# 1. Link Signal (scan the QR code in Signal → Settings → Linked devices)
signal-cli link -n "ben-e"            # prints a sgnl:// link; turn it into a QR code, e.g.
                                      #   brew install qrencode && qrencode -t ANSIUTF8 '<link>'

# 2. Configure
cp .env.example .env && chmod 600 .env
$EDITOR .env                          # at least SIGNAL_OWNER_NUMBER; set OWNER_NAME / ASSISTANT_NAME

# 3. Mail: make sure `claude mcp list` shows your mailbird server as connected
#    (the agent reads its connection details from the same entry in ~/.claude.json)

# 4. Skills: install the examples, then fill in the TODO(owner) parts (see below)
npm run install:skills

# 5. Check everything, then run it for real
npm run doctor
npm run install:launchd               # installs a launchd job; the agent starts now and at login
```

Send yourself a message on Signal. The first heartbeat tick only records a **baseline** of your current inbox (it does not triage old mail). The first daily brief runs on the next tick at or after 07:00.

### Skills

The agent does its domain work through ordinary Claude Code skills in `~/.claude/skills/`. The repo ships anonymised templates in `examples/skills/`, and `npm run install:skills` copies them there. It never overwrites a skill you already have (`--force` does).

| Skill | Role | You fill in |
|---|---|---|
| `daily-brief` | the brief's structure and rules | nothing, it is complete |
| `mailbird` | triage rules, the newsletter-radar rules, your reply voice | your voice, your booking link |
| `notion-tasks` | your task page and tidy rules (every deadline becomes a task) | your task page URL and id |
| `calendar` | conflict flagging, travel-booking events | your calendars and time zone |
| `meeting-prep` | when a meeting needs prep, where prep pages live | your Meetings database, view and template ids |
| `mailbird-troubleshooting` | fixing a broken Mailbird connection | nothing |

Every place that needs your own value is marked `TODO(owner)`, and `npm run doctor` warns until none are left. Drop any skill you do not use and delete the matching steps from the brief skill. Your filled-in skills hold personal details (addresses, Notion ids, your writing style), so they live in `~/.claude/skills/`, outside this repo. Keep them in a private repo of their own if you want them versioned.

**Keep the agent's view of tools in step with your skills.** To save cost and time the model only sees four Notion tools (search, fetch, create-pages, update-page), and the Gmail, Drive, Docs and trading connectors are hidden. If a skill of yours needs another tool, add it to `NOTION_TOOLS` or remove the connector from `HIDDEN_CONNECTORS` in `.env`; otherwise that skill silently fails.

## Daily use

- **Chat**: message yourself. Replies are formatted with Signal's native styles (bold, italic, strikethrough, monospace).
- **Approve**: reply `yes` / `no`, a sentence, or react 👍 / 👎 on the question.
- `npm run doctor`: health check (tooling, permissions, Signal, Mailbird, login, launchd, skills, heartbeat liveness, spend, recent errors).
- `npm run report [hours]`: what the heartbeat archived, alerted and queued (local times).
- `npm run triage-check [n]`: how the heartbeat would classify your newest `n` emails and what it would do, without acting or changing anything. A safe way to check the classifier on real mail.
- `npm run restore <conversationId>`: put an archived conversation back in the inbox.
- `npm test` / `npm run typecheck` / `npm run check:secrets`.
- Folders: `state/` (bookkeeping), `logs/` (`agent.log` in local time, redacted and rotated; `audit.jsonl`, the audit trail; raw crash output, if any, in `launchd-stderr.log`), `memory/` (what the assistant remembers). All owner-only, all git-ignored.
- **Memory**: tell it things in chat ("remember that no meetings before 10", "forget the London trip", "what do you remember?"). It saves one markdown note per fact in `memory/notes/` (the SDK's auto-memory) and tells you on Signal exactly what it saved; say "forget that" to undo. You can also edit or add notes by hand: name the file `<category>-<slug>.md` with a category of `triage`, `people`, `scheduling`, `context`, `brief` or `style` (background jobs only read notes with one of those prefixes), and add `expires: YYYY-MM-DD` to the front matter for a temporary fact. Your writing preferences live here too, e.g. "Never use em dashes"; your daily-brief topics are `brief-` notes.
- Tuning: every knob is an env var, listed in `.env.example` (heartbeat interval, quiet hours, brief start hour, archive cap, spend limit, model). They are validated at startup: a typo stops the agent with a clear message in the log.
- Chat session: it starts fresh after `CHAT_IDLE_RESET_HOURS` (default 6) idle, and is compacted when a turn's context passes `CHAT_COMPACT_TOKENS` (default 60000), so long conversations stay cheap. Both are optional settings in `.env`.
- Pause: `touch state/paused` (or write a date into it to resume on that day). The heartbeat idles at night by itself (22:00 to 07:00 by default) and catches up in the morning.

Back to the [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Safety](SAFETY.md) · [Adapting](ADAPTING.md)
