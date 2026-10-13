# Setup

## Status and limits

This is a personal project that runs daily for its author. It works, its safety-critical logic is unit-tested, and it is opinionated. It is **macOS only**, built for **one user**, and it works only while your Mac is awake. Read the code before trusting it with your inbox, and check Anthropic's current terms for using your plan this way.

## Requirements

- **macOS** (launchd supervises the agent; Mailbird is the mail client). Linux would work for everything except those two.
- **Node 24+** (TypeScript runs directly, there is no build step).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/overview)** installed and logged in (`claude auth login`). The agent uses your stored login so it can reach your claude.ai connectors (Notion, Google Calendar, Gmail…). *Check Anthropic's current terms for using your plan for personal automation like this.* An API key or `claude setup-token` also work but cannot use those connectors (see `HARNESS_AUTH` in `.env.example`).
- **[signal-cli](https://github.com/AsamK/signal-cli)** (`brew install signal-cli`). Either linked to your own Signal account as a secondary device (Note to Self, the default), or, better, registered as the assistant's own account ([SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md)).
- **A mail client with an MCP server.** This repo uses [Mailbird](https://www.getmailbird.com/); see [Why a local mail client](ADAPTING.md#why-the-default-is-a-local-client) and [ADAPTING.md](ADAPTING.md) if you use Gmail only.
- Optional: Notion and Google Calendar connected under *claude.ai → Settings → Connectors*, for the task and calendar parts of the brief.

## Install

```bash
git clone https://github.com/<you>/ted-personal-assistant && cd ted-personal-assistant
npm install

# 1. Link Signal (scan the QR code in Signal → Settings → Linked devices)
signal-cli link -n "ted-personal-assistant"            # prints a sgnl:// link; turn it into a QR code, e.g.
                                      #   brew install qrencode && qrencode -t ANSIUTF8 '<link>'

# 2. Configure
cp .env.example .env && chmod 600 .env
$EDITOR .env                          # at least SIGNAL_OWNER_NUMBER; set OWNER_NAME / ASSISTANT_NAME

# 3. Mail: make sure `claude mcp list` shows your mailbird server as connected
#    (the agent reads its connection details from the same entry in ~/.claude.json)

# 5. Check everything, then run it for real
npm run doctor
npm run install:launchd               # installs a launchd job; the agent starts now and at login
```

Send yourself a message on Signal. The first heartbeat tick only records a **baseline** of your current inbox (it does not triage old mail). The first daily brief runs on the next tick at or after 07:00.

### Skills and first-time setup

The skills the agent works with ship in the repo, in `plugin/skills/`, and are loaded straight from there: there is nothing to install or copy. They hold no personal details. What they need to know about you (which calendars to check, where your Notion task list and meeting pages are, how you write) lives in your memory notes, and the agent sets those up with you in the chat.

**Recommended: give the assistant its own Signal account**, so you chat with a contact that has a name and a picture, and see "typing…", instead of with yourself in Note to Self. It takes about ten minutes: [SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md). Everything works in Note to Self without it, and you can switch at any time (set or remove `SIGNAL_ACCOUNT`).

After the agent is running, send it **"set up"** on Signal. It walks you through one item at a time, and you can skip any:

| Item | What it does | Saved as |
|---|---|---|
| Calendars | lists your Google calendars, you pick which count, plus your time zone | `setup-calendars.md` |
| Tasks | searches Notion for your task list and uses it (it asks only if it finds nothing or several, and can create one for you) | `setup-tasks.md` |
| Meeting notes | searches Notion for your meetings database the same way, or creates a page for prep notes | `setup-meetings.md` |
| How you write | with your permission, reads up to 15 of your sent mails and describes your style for you to correct | `voice-writing.md` |
| Optional | booking link, topics for the brief's radar | `setup-booking-link.md`, `brief-radar-topics.md` |

**Notion and Google Calendar come through connectors in your Claude account** (Settings, then Connectors). If one is not connected, its tools do not exist, and the agent says so plainly ("Notion isn't connected") instead of asking you to type in what the connector would have told it, and skips that part: tasks and meeting prep without Notion, the calendar review without Google Calendar. Mail triage, chat and writing-style setup need neither. Connect it, message the agent again, and it carries on. `npm run doctor` shows the status of each connector as of the last run.

Until something is set up, the parts of the agent that need it skip it and say so (in chat, it offers to set it up; in the daily brief, a one-line "🛠 Setup" note at the end). `npm run doctor` shows what is missing. To change something later, say "set up my calendar" (or tasks, meetings, writing) again, or edit the note in `memory/notes/`.

The skills are `daily-brief` (the brief's structure), `mailbird` (triage and drafting rules), `calendar`, `notion-tasks`, `meeting-prep`, `mailbird-troubleshooting` and `setup`. To change how a domain is handled, edit the file in `plugin/skills/`. Your own skills in `~/.claude/skills/` are not offered to the agent.

**Keep the agent's view of tools in step with the skills.** To save cost and time the model only sees four Notion tools (search, fetch, create-pages, update-page), and the Gmail, Drive, Docs and trading connectors are hidden. If a skill you write needs another tool, add it to `NOTION_TOOLS` or remove the connector from `HIDDEN_CONNECTORS` in `.env`; otherwise that skill silently fails.

## Daily use

- **Chat**: message yourself. Replies are formatted with Signal's native styles (bold, italic, strikethrough, monospace).
- **Send a drafted reply**: when the assistant has drafted a reply for you (it shows "✉️ Reply ready" with the recipient and text), react 👍 to send it exactly as shown, or reply to the message to change something.
- **Approve**: reply `yes` / `no`, a sentence, or react 👍 / 👎 on the question.
- `npm run doctor`: health check (tooling, permissions, Signal, Mailbird, login, launchd, skills, heartbeat liveness, spend, recent errors).
- `npm run report [hours]`: what the heartbeat archived, alerted and queued (local times).
- `npm run triage-check [n]`: how the heartbeat would classify your newest `n` emails and what it would do, without acting or changing anything. A safe way to check the classifier on real mail.
- `npm run restore <conversationId>`: put an archived conversation back in the inbox.
- `npm test` / `npm run typecheck` / `npm run check:secrets`.
- Folders: `state/` (bookkeeping), `logs/` (`agent.log` in local time, redacted and rotated; `audit.jsonl`, the audit trail; raw crash output, if any, in `launchd-stderr.log`), `memory/` (what the assistant remembers). All owner-only, all git-ignored.
- **Memory**: tell it things in chat ("remember that no meetings before 10", "forget the London trip", "what do you remember?"). It saves one markdown note per fact in `memory/notes/` (the SDK's auto-memory) and tells you on Signal exactly what it saved; say "forget that" to undo. You can also edit or add notes by hand: name the file `<category>-<slug>.md` with a category of `triage`, `people`, `scheduling`, `context`, `brief` or `style` (background jobs only read notes with one of those prefixes), and add `expires: YYYY-MM-DD` to the front matter for a temporary fact. Your writing preferences live here too, e.g. "Never use em dashes"; your daily-brief topics are `brief-` notes.
- **Nightly dream**: once a day, before the brief, a model with no tools reads what you told the assistant since the last time and proposes changes to its memory notes: new facts about you, people, preferences and projects, merges of duplicates, expired notes dropped. See [ARCHITECTURE.md](ARCHITECTURE.md#the-dream). `DREAM=off` disables it; say "undo the dream" to put the notes back.
- **Voice messages** (optional): send a voice note in Note to Self and it is transcribed on your Mac with whisper.cpp (nothing leaves it), handled like typed text. The transcript is logged with your other messages in `logs/messages.jsonl`, and you can ask the assistant what a voice message said (it may read `logs/`, `state/` and `memory/` and search the logs, read-only).
- **Proactive radar**: while you are awake it looks (about an hour before your next meeting, at most every `RADAR_MINUTES`, default 180, apart) at your calendar and messages you only when something deserves it (a meeting about to start, with its prep; a clash). Capped at `MAX_PROACTIVE_PER_DAY`; `PROACTIVE=off` disables it. It needs the calendar set up (say "set up").
- Tuning: every knob is an env var, listed in `.env.example` (heartbeat interval, quiet hours, brief start hour, archive cap, spend limit, model). They are validated at startup: a typo stops the agent with a clear message in the log.
- Chat session: it starts fresh after `CHAT_IDLE_RESET_HOURS` (default 6) idle, and is compacted when a turn's context passes `CHAT_COMPACT_TOKENS` (default 60000), so long conversations stay cheap. Both are optional settings in `.env`.
- Pause: `touch state/paused` (or write a date into it to resume on that day). The heartbeat idles at night by itself (22:00 to 07:00 by default) and catches up in the morning.

Back to the [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Safety](SAFETY.md) · [Adapting](ADAPTING.md)
