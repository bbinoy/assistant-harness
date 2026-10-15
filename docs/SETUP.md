# Setup

## Status and limits

This is a personal project that runs daily for its author. It works, its safety-critical logic is unit-tested, and it is opinionated. It is **macOS only**, built for **one user**, and it works only while your Mac is awake. Read the code before trusting it with your inbox, and check Anthropic's current terms for using your plan this way.

## Requirements

- **macOS** (launchd supervises the agent; Mailbird is the mail client). Linux would work for everything except those two.
- **Node 24+** (TypeScript runs directly, there is no build step).
- **[Claude Code](https://docs.claude.com/en/docs/claude-code/overview)** installed and logged in (`claude auth login`). The agent uses your stored login so it can reach your claude.ai connectors (Notion, Google Calendar, Gmail…). *Check Anthropic's current terms for using your plan for personal automation like this.* An API key or `claude setup-token` also work but cannot use those connectors (see `HARNESS_AUTH` in `.env.example`).
- **[signal-cli](https://github.com/AsamK/signal-cli)** (`brew install signal-cli`). Either linked to your own Signal account as a secondary device (Note to Self, the default), or, better, registered as the assistant's own account ([SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md)).
- **A mail client with an MCP server**, unless you run chat only (below). This repo uses [Mailbird](https://www.getmailbird.com/); see [Why a local mail client](ADAPTING.md#why-the-default-is-a-local-client). Gmail only: use the Gmail connector instead ([Gmail](#gmail-no-local-mail-client) below).
- Optional: Notion and Google Calendar connected under *claude.ai → Settings → Connectors*, for the task and calendar parts of the brief.

## Install

```bash
git clone https://github.com/bbinoy/ted-personal-assistant && cd ted-personal-assistant
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

### Chat only (no mail)

Mail is optional. For the Signal chat, memory, wake-ups, the calendar radar and a daily brief without an inbox, you need only **Claude Code** (logged in) and **signal-cli**: skip the Mailbird step above and put this in `.env`:

```
MAIL_PROVIDER=none
```

What changes: no mail client is started or contacted anywhere; the heartbeat only keeps its liveness line (one log line at start, `mail: off (MAIL_PROVIDER=none)`, nothing per tick); the daily brief has no email step, so the brief the model writes is the deliverable, and you get its pep talk and focus on Signal (say "brief" for the rest, it is saved in `memory/last-brief.md`); the model is not offered the mail skills or the Mailbird tools and is told there is no mail; `npm run doctor` shows `mail: off` as OK and does not look for Mailbird; setup does not ask about your writing style or sent mail; `npm run restore` and `npm run triage-check` refuse to run. The default is `MAIL_PROVIDER=mailbird`, which behaves as described everywhere else in these docs.

### Gmail (no local mail client)

If your mail is in Gmail you can skip Mailbird: the assistant uses the Gmail connector of your Claude account, the same way it uses Notion and Google Calendar. Connect Gmail in your Claude account (Settings, Connectors), make sure `HARNESS_AUTH=login`, and set in `.env`:

```
MAIL_PROVIDER=gmail
MAIL_SELF_ADDRESS=you@example.com
```

`MAIL_SELF_ADDRESS` is your own address. It is the only address the daily brief may ever be emailed to (a hard check in code, not a request to the model).

What works:

- **Heartbeat triage.** Every few minutes a small model lists the inbox (`in:inbox newer_than:7d`) and classifies new threads, as with Mailbird. This costs one small model call per tick for the connector round trip, even when nothing is new.
- **Archiving is log-only for the first week.** An archive is removing the INBOX label (reversible). With the default `GMAIL_ARCHIVE_LIVE=false` the heartbeat and any archive the assistant tries are recorded as `would-archive` and nothing is archived; `npm run report` and the daily brief say so. When the classifications look right, set `GMAIL_ARCHIVE_LIVE=true`. `npm run restore <threadId>` puts an archived thread back in the inbox.
- **Drafts and sends.** Drafts (new or in-thread) are made freely. `send_message`, `reply` and `forward` always go through the approval flow, shown with the real recipients (including cc, bcc and attachments); a send of a draft is shown from the draft as read back from Gmail. In chat the approval judge may skip the question for a send you just asked for (`AUTO_APPROVE`); unattended runs always ask.
- **Never allowed**, whoever asks: trash, spam, delete, the labels `TRASH` and `SPAM` on any label tool, reading attachment content, deleting or renaming labels.
- **The brief** goes to Signal as before. `BRIEF_EMAIL=on` also emails the full brief to `MAIL_SELF_ADDRESS` (and only there).
- **Not built for Gmail**: the background reply handler and its "Reply ready" drafts (they use Mailbird's tools). Mail the classifier would hand to the handler stays in the inbox and is listed in the brief.

`npm run doctor` checks that `MAIL_SELF_ADDRESS` is set and that the Gmail connector was available in the last run (start the agent once first). The connector's results were written against its published tool descriptions and tested on recorded-shape fake output; watch the first days in `npm run report` and `logs/audit.jsonl`.

### Skills and first-time setup

The skills the agent works with ship in the repo, in `plugin/skills/`, and are loaded straight from there: there is nothing to install or copy. They hold no personal details. What they need to know about you (which calendars to check, where your Notion task list and meeting pages are, how you write) lives in your memory notes, and the agent sets those up with you in the chat.

**Recommended: give the assistant its own Signal account**, so you chat with a contact that has a name and a picture, and see "typing…", instead of with yourself in Note to Self. It takes about ten minutes: [SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md). Everything works in Note to Self without it, and you can switch at any time (set or remove `SIGNAL_ACCOUNT`).

After the agent is running, send it **"set up"** on Signal. It walks you through one item at a time, and you can skip any:

| Item | What it does | Saved as |
|---|---|---|
| Calendars | lists your Google calendars, you pick which count, plus your time zone | `setup-calendars.md` |
| Tasks | searches Notion for your task list and uses it (it asks only if it finds nothing or several, and can create one for you) | `setup-tasks.md` |
| Meeting notes | searches Notion for your meetings database the same way, or creates a page for prep notes | `setup-meetings.md` |
| How you write (mail only) | with your permission, reads up to 15 of your sent mails and describes your style for you to correct | `voice-writing.md` |
| Optional | booking link, topics for the brief's radar | `setup-booking-link.md`, `brief-radar-topics.md` |

**Notion and Google Calendar come through connectors in your Claude account** (Settings, then Connectors). If one is not connected, its tools do not exist, and the agent says so plainly ("Notion isn't connected") instead of asking you to type in what the connector would have told it, and skips that part: tasks and meeting prep without Notion, the calendar review without Google Calendar. Mail triage, chat and writing-style setup need neither. Connect it, message the agent again, and it carries on. `npm run doctor` shows the status of each connector as of the last run.

Until something is set up, the parts of the agent that need it skip it and say so (in chat, it offers to set it up; in the daily brief, a one-line "🛠 Setup" note at the end). `npm run doctor` shows what is missing. To change something later, say "set up my calendar" (or tasks, meetings, writing) again, or edit the note in `memory/notes/`.

The skills are `daily-brief` (the brief's structure), `mailbird` (triage and drafting rules), `calendar`, `notion-tasks`, `meeting-prep`, `mailbird-troubleshooting` and `setup`. To change how a domain is handled, edit the file in `plugin/skills/`. Your own skills in `~/.claude/skills/` are not offered to the agent.

**Keep the agent's view of tools in step with the skills.** To save cost and time the model only sees four Notion tools (search, fetch, create-pages, update-page), and the Gmail, Drive, Docs and trading connectors are hidden. If a skill you write needs another tool, add it to `NOTION_TOOLS` or remove the connector from `HIDDEN_CONNECTORS` in `.env`; otherwise that skill silently fails.

## Browser (forms and bookings)

On by default (`BROWSE=on`). `npm install` fetches the pinned `@playwright/mcp` and runs `npm run setup:browse`, which downloads a headless Chromium (about 100 MB) into `state/browse/browsers`, not anywhere global; delete that folder to remove it. If the download failed (offline, `BROWSE_SKIP_INSTALL=1`), run `npm run setup:browse` yourself; until then the browse tool answers "not set up" and `npm run doctor` says what is missing. `BROWSE_BROWSER_PATH` points it at a Chromium or Chrome you already have. `BROWSE=off` removes the tool from every run. A real-world check that costs a few cents: `npm run browse:smoke` (example.com, the httpbin pizza form up to but not including its submit button; `-- submit` shows the approval text a commit step produces, declined; `-- big` a large page). See [SAFETY](SAFETY.md) for what it can and cannot do.

## Daily use

- **Chat**: message yourself. Replies are formatted with Signal's native styles (bold, italic, strikethrough, monospace).
- **Send a drafted reply**: when the assistant has drafted a reply for you (it shows "✉️ Reply ready" with the recipient and text), react 👍 to send it exactly as shown, or reply to the message to change something.
- **Approve**: reply `yes` / `no`, a sentence, or react 👍 / 👎 on the question.
- `npm run doctor`: health check (tooling, permissions, Signal, Mailbird, login, launchd, skills, heartbeat liveness, spend, recent errors).
- `npm run report [hours]`: what the heartbeat archived, alerted and queued (local times).
- `npm run triage-check [n]`: how the heartbeat would classify your newest `n` emails and what it would do, without acting or changing anything. A safe way to check the classifier on real mail.
- `npm run restore <conversationId>`: put an archived conversation back in the inbox.
- `npm test` / `npm run typecheck` / `npm run check:secrets`.
- Folders: `state/` (bookkeeping), `logs/` (`agent.log` in local time, redacted and rotated; `audit.jsonl`, the audit trail; raw crash output, if any, in `launchd-stderr.log`, cut to its last 1 MB at start when it is over 5 MB), `memory/` (what the assistant remembers). All owner-only, all git-ignored.
- **Memory**: tell it things in chat ("remember that no meetings before 10", "forget the London trip", "what do you remember?"). It saves one markdown note per fact in `memory/notes/` (the SDK's auto-memory) and tells you on Signal exactly what it saved; say "forget that" to undo. You can also edit or add notes by hand: name the file `<category>-<slug>.md` with a category of `triage`, `people`, `scheduling`, `context`, `brief` or `style` (background jobs only read notes with one of those prefixes), and add `expires: YYYY-MM-DD` to the front matter for a temporary fact. Your writing preferences live here too, e.g. "Never use em dashes"; your daily-brief topics are `brief-` notes.
- **Spoken replies** (optional): the assistant can answer by voice when it fits, in a voice you choose, made locally with [Kokoro](https://github.com/thewh1teagle/kokoro-onnx) (nothing leaves your Mac). Run `scripts/setup-tts.sh` once (about 400 MB; needs Python 3.10+ and ffmpeg), and use the assistant's own Signal account ([SIGNAL-ACCOUNT.md](SIGNAL-ACCOUNT.md)). The model decides per reply whether to speak or write: short conversational answers are spoken, long, detailed or exact ones (times, figures, links) stay text. `VOICE_REPLIES=off` turns it off; `TTS_VOICE` picks the voice. A different voice from a hosted service or your own server is possible but sends the spoken words there: see [REMOTE-TTS.md](REMOTE-TTS.md).
- **Nightly dream**: once a day, before the brief, a model with no tools reads what you told the assistant since the last time and proposes changes to its memory notes: new facts about you, people, preferences and projects, merges of duplicates, expired notes dropped. It works silently and logs what it did. See [ARCHITECTURE.md](ARCHITECTURE.md#the-dream). `DREAM=off` disables it; say "undo the dream" to put the notes back.
- **Voice messages** (optional): send a voice note in Note to Self and it is transcribed on your Mac with whisper.cpp (nothing leaves it), handled like typed text (at most `TRANSCRIBE_CONCURRENCY`, default 2, are transcribed at once, in your chat and all groups together; more wait in line). The transcript is logged with your other messages in `logs/messages.jsonl`, and you can ask the assistant what a voice message said (it may read `logs/`, `state/` and `memory/` and search the logs, read-only).
- **Proactive radar**: while you are awake it looks (about an hour before your next meeting, at most every `RADAR_MINUTES`, default 180, apart) at your calendar and messages you only when something deserves it (a meeting about to start, with its prep; a clash). Capped at `MAX_PROACTIVE_PER_DAY` messages of its own per day (mail alerts do not count); `PROACTIVE=off` disables it. It needs the calendar set up (say "set up").
- Tuning: every knob is an env var, listed in `.env.example` (heartbeat interval, quiet hours, brief start hour, archive cap, spend limit, model). They are validated at startup: a typo stops the agent with a clear message in the log.
- Chat session: it keeps recent history across days (never reset just because time passed) and is compacted when the conversation has grown `CHAT_COMPACT_GROWTH_TOKENS` (default 100000) beyond its first turn: in the background once it has been quiet for `COMPACT_QUIET_MINUTES` (default 5), or right after a reply if it grew 1.5 times past that, the same for your chat and every group, so long conversations stay cheap. Both are optional settings in `.env`.
- Pause: `touch state/paused` (or write a date into it to resume on that day). The heartbeat idles at night by itself (22:00 to 07:00 by default) and catches up in the morning.

Back to the [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Safety](SAFETY.md) · [Adapting](ADAPTING.md)
