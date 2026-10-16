# Ted

**A personable assistant that lives in your Signal chats, remembers what you tell it, and tidies its own notes overnight with an undo button.**

Ted runs on your Mac and talks to you like a contact, not a command line. Tell it something once and it keeps it. It can also handle the dull parts of your day (mail, calendar, tasks, meeting prep), and it asks on your phone before it does anything that counts.

Built with [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). It is small enough to read (about 7,500 lines of TypeScript in `src/`) and made to be bent to your life. The "small enough to understand" idea is one we borrowed with thanks from [NanoClaw](https://github.com/nanocoai/nanoclaw). Ted is not built on NanoClaw or OpenClaw.

<!-- TODO screenshot -->

> **What you need**
> - A Mac (macOS, Node 24+), awake whenever you want Ted to answer.
> - [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), logged in with a subscription.
> - [signal-cli](https://github.com/AsamK/signal-cli) with a Signal account: your own (Ted answers in *Note to Self*) or, better, a second one so Ted is a separate contact ([how](docs/SIGNAL-ACCOUNT.md)).
> - [Mailbird](https://www.getmailbird.com/) with its MCP server. The setup docs list it as required, and `npm run doctor` checks it.
> - Optional: Notion and Google Calendar as claude.ai connectors; ffmpeg and whisper.cpp for voice notes in; Kokoro (`scripts/setup-tts.sh`) for voice out.
>
> **Setup is heavy today.** Expect a terminal, several tools to install and an hour or more. There is no documented chat-only mode without a mail client. The code runs the mail check separately from chat, memory and wake-ups, so a failing mail client should not stop them ([ARCHITECTURE.md](docs/ARCHITECTURE.md)), but that setup is untested and unsupported. The smallest supported setup is Claude Code + signal-cli + Mailbird, chatting in Note to Self. Everything else (Notion, calendar, voice, its own Signal account) is optional. Step by step: [docs/SETUP.md](docs/SETUP.md).

## Why it feels like a person

- **Its own contact.** Give Ted its own Signal account (a name, a picture) and you chat with a contact instead of with yourself.
- **Typing, seen, reactions.** It marks your message read, shows "typing..." while it works, and sometimes answers with just an emoji on your message. (Note to Self has no typing indicator, so small icons show the state instead.)
- **Voice in and out.** A voice note is transcribed on your Mac with whisper.cpp. Ted may answer with a voice message when that fits (a pep talk, a joke; never for times and figures), generated locally with Kokoro. A hosted voice is an opt-in that sends the spoken words away ([REMOTE-TTS.md](docs/REMOTE-TTS.md)).
- **Photos and files.** Send a picture (JPEG, PNG, WebP, GIF or iPhone HEIC), a PDF or a text file (txt, md, csv, json, log, ics, vcf) and Ted reads it. Other file types are not opened, and Ted says so.
- **Groups, where it decides when to speak.** Add Ted to a group and a small model judges each message: Ted always answers when addressed and otherwise joins in only when it fits. Each group has its own notes and history, and Ted brings none of your private data there.
- **A character, by default Ted Lasso.** Warm, folksy and relentlessly optimistic, with the help coming first. Change it by telling Ted what you want: your style notes override the default.

## Memory that tidies itself

- **Notes.** "Dr. Weber is a client, write to him formally." "No meetings before 10." Ted saves one small markdown note per fact in `memory/notes/`, tells you what it saved, and forgets on request. You can read and edit the files yourself.
- **The nightly dream.** Once a day a model with no tools reads what you said and proposes edits: new facts, merged duplicates, expired notes dropped. Code, not the model, decides what is applied. A new note needs a verbatim quote of your own words, so a mail or a stray reaction cannot plant a memory.
- **Snapshots and undo.** The notes are copied first (7 snapshots kept), every change is logged, and "undo the dream" restores them.
- **Compaction.** Chats keep their recent history across days and are compacted in the background when they grow long, so Ted keeps the thread without cost growing without bound.

## Proactive, with one gate

- **Daily brief.** A short version on Signal (a pep talk and a focus), the full one by email.
- **Calendar radar.** It looks at your calendar every few hours and about an hour before your next meeting, and messages you only for a meeting about to start (with its prep) or a clash. Capped per day.
- **A browser for forms and bookings.** A separate, sandboxed browser worker (headless, no logins, no cookies, no access to your mail, calendar or notes) can look things up behind a web form and fill one in for you, in your chat, in a background job or in a group. Anything that books, buys or sends is shown first with the real button and the values entered; card, password and code fields are never filled (it hands you the link instead). `BROWSE=off` switches it off. [Safety](docs/SAFETY.md).
- **Schedules in plain notes.** "Every morning post a fun fact", "nudge us on Friday", "brief at 6:30", "no radar on weekends": write it in chat (or in a group) and it works.
- **One gate.** A small model checks the clock, the notes and the recent log and decides whether to act. It chooses only *when*. What a run may do is fixed in code, and a daily spend limit applies.

## Safety, honestly

- **Phone approvals with the exact arguments.** Sending, forwarding, sharing and anything that involves other people ask first. The question is built from the real arguments, not a model's summary, and a timeout means no.
- **Permission policy in code.** Every tool call is allow, ask or deny in `src/policy.ts`, tested against real tool names. Deletes are denied. Memory can shape tone and priorities but never grant permissions.
- **A judge that can skip questions, inside a floor.** A small model may skip a few low-risk questions (such as a new calendar event with nobody else on it). The floor is code: sends, forwards, shares and anything involving other people always ask. Skips are logged, and `AUTO_APPROVE=off` turns the judge off.
- **Untrusted content cleaned at the door.** Messages, mail, web pages and tool results lose hidden and look-alike characters and invisible HTML before a model reads them, and are treated as data.
- **What this is not.** This is application-level policy running on your Mac as your user. It is **not** OS-level or container isolation. Prompt injection is contained and tested, not eliminated: a hostile mail can still try. `signal-cli` keeps its keys unencrypted on disk, so keep FileVault on.

Everything Ted does is logged (`npm run report`), and `touch state/paused` pauses it. Layer by layer: [docs/SAFETY.md](docs/SAFETY.md).

## What it can do for your day

- **Inbox.** Every 15 minutes it checks for new mail. Newsletters, notifications and cold outreach are archived (never deleted; `npm run restore` brings one back). Anything that needs you arrives as one short message. Routine requests get a reply drafted from your calendar and left as a draft; sending asks first.
- **Meeting prep** from your Notion notes and past threads, with a draft agenda.
- **Tasks.** It reads your Notion task list, spots what is overdue, adds tasks from mail and removes ones clearly done.
- **Calendar.** Creates events from mail, flags conflicts and proposes fixes. Plain events on your own calendar just happen (logged); anything with other people asks.
- **Newsletter digest.** The top three nuggets, based on your preferences.

Tasks, meeting prep and calendar need the Notion and Google Calendar connectors. Without one, Ted skips that part and says so.

## A day in the life: AFC Richmond edition

*(Characters borrowed with love from Ted Lasso. Nobody at Richmond has been consulted.)*

**Tuesday, 07:00.** Your Mac wakes and the daily brief starts. The full brief lands in your inbox. On Signal you get the short version:

> **💪 Pep talk**
> Mornin', Coach! Now, I know the inbox looks like a pile of angry geese, but today is really just three things, and you've handled worse before your first biscuit. Answer the Board before 11:00 and everything else is a nice, easy warm-up.
>
> **🎯 Focus**
> **Answer Rebecca about the stadium budget before 11:00.** She's asked twice, and the second message just says "Ted. Budget."
> - Press conference prep at 14:00, the prep page is ready.
> - Ring the boiler repairman. Again.

**10:42.** An urgent mail arrives while you are in a meeting, so you get exactly one alert:

> Keeley Jones needs your decision on the PR plan by noon: the whole campaign is waiting on a yes or no.

**Any time.** Just talk to Ted, in text or a voice note:

> **You:** what's on my plate today?
> **Ted:** Three things, and not one of them is a lion! 🦁
> - **Rebecca** wants an answer on the budget by 11:00.
> - Kickball clinic at 17:30 collides with the Sponsors' Brunch. I'd move the brunch. Nobody ever won a championship over a quiche.
> - Your coaching licence is 4 days overdue. No judgment here, buddy.
>
> **You:** remember that messages from Jamie are never urgent
> **Ted:** Saved: Jamie's "URGENT!!!" emails will now wait their turn. Which, between you and me, is a long line.

**11:20.** Anything involving other people waits for your say-so:

> **You:** put "find a decent cup of tea" in my calendar tomorrow at 15:00, and invite Coach Beard
> **Ted:** Approve?
> 📅 Change calendar event
> "find a decent cup of tea"
> 👥 Coach Beard
>
> Reply yes, no, or tell me what to change, or react 👍 / 👎 (15 min, then I assume no).
>
> **You:** yes but make it 16:00
> **Ted:** Applied your change: startTime → 2026-10-14T16:00:00, endTime → 2026-10-14T17:00:00

## How it compares

Personal agents are having a moment. Ted is deliberately narrow: one person, your own Mac, Signal as the front door, and a question on your phone before anything leaves it. The cells for other products come from public descriptions, not from using them.

| | **Ted** | **[OpenClaw](https://en.wikipedia.org/wiki/OpenClaw)** | **[Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown)** | **[Instinct](https://www.vellum.ai/blog/official-instinct-breakdown)** |
|---|---|---|---|---|
| **What it is** | A personable assistant in your Signal chats, with memory and mail, calendar and task skills | A general-purpose agent platform | A general agent on a cloud computer | A general assistant you text or call |
| **Before it acts** | Code-enforced policy: reads run, outward actions ask on your phone (in chat, a send you asked for exactly may go through on a small model's judgement), deletes are denied | Per-agent tool permissions; sandboxed or full system access, your choice | Allow once / always / deny, plus auto-review rules | Reported by Vellum: no approval step required for actions. Corrections welcome |
| **Scope of power** | Mail, calendar and task tools, plus web search (opening a page asks first, unless the approval judge sees it plainly serves your request). No shell; files only inside its own memory notes | Can be given shell, file system and web automation; 100+ skills plus a marketplace | Connectors to Gmail, Outlook, Drive, Teams, Salesforce and more | Email, messages, screen, audio, location |
| **Source** | Open (MIT), about 7,500 lines of TypeScript in `src/` | Open, large | Proprietary | Proprietary |
| **Cost** | Your Claude plan. Measured in October 2026 with Sonnet: about $0.01 for a simple warm reply, $0.03 to $0.08 for a calendar question | Free software plus your model costs | $200/month, or bundled with SuperGrok Heavy and Cursor plans | Free in invite-only beta, pricing not published |
| **Runs on** | Your Mac | Your machine or server | xAI's cloud | The vendor's cloud |
| **Where you talk to it** | Signal (swappable for Telegram, Slack...) | WhatsApp, Telegram, Signal, Slack, iMessage and more | Desktop and iPhone app | iMessage, WhatsApp, phone calls |

**Ted may suit you** if you want a small, readable assistant for one person, with memory and rules you can read in code. **OpenClaw** fits a broad, self-hosted agent that can do much more on your machine. **Grok Bot or Instinct** fit if you would rather have a hosted product than run anything yourself.

*Based on public descriptions as of October 2026 ([OpenClaw](https://en.wikipedia.org/wiki/OpenClaw), [OpenClaw heartbeat](https://openclawlab.com/en/docs/gateway/heartbeat/), [Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown), [Instinct, as reported by Vellum](https://www.vellum.ai/blog/official-instinct-breakdown)). These products change fast; corrections welcome.*

## Quick start

```bash
git clone https://github.com/bbinoy/ted-personal-assistant && cd ted-personal-assistant
npm install
cp .env.example .env && chmod 600 .env     # add your Signal number and names
npm run doctor                              # checks everything is in place
npm run install:launchd                     # starts it now and at every login
```

Link signal-cli and check your mail client first: [docs/SETUP.md](docs/SETUP.md). For a separate Signal contact for Ted (recommended), see [docs/SIGNAL-ACCOUNT.md](docs/SIGNAL-ACCOUNT.md). Then message Ted "set up" in Signal: it finds your calendars and Notion pages, learns how you write from your sent mail (if you allow it), and saves what it learns as notes. No files to edit.

**Keep it running while you're away.** Ted lives on your Mac, so it only works while the Mac is awake. If it stays plugged in, open *System Settings > Battery > Options* (on a desktop Mac: *Energy*) and turn on *Prevent automatic sleeping on power adapter when the display is off*. The screen can still turn off. On a laptop, keep the lid open. If the Mac does sleep, nothing breaks: Ted picks up where it left off when it wakes.

**No mail client?** With `MAIL_PROVIDER=none` Ted runs chat only (Signal chat, memory, wake-ups, calendar radar, a daily brief of calendar and tasks): [chat-only setup](docs/SETUP.md#chat-only-no-mail).

## Make it yours

- **Your name, its name, its personality**: three lines in `.env`, one prompt in `src/persona.ts`, or just tell it in chat.
- **Your preferences**: tone, length, who matters, what the brief includes. They live in small notes (`memory/notes/`) that you can also change by chatting. No code, no restart.
- **Your mail**: it ships with [Mailbird](https://www.getmailbird.com/) because that is how it reaches Proton Mail, whose end-to-end encryption means there is no server to point an agent at. If you use Gmail only, set `MAIL_PROVIDER=gmail` to use your Claude account's Gmail connector instead and skip the local client ([docs/SETUP.md](docs/SETUP.md#gmail-no-local-mail-client)).
- **Your messenger**: Signal is a thin layer. Telegram, Slack, iMessage and WhatsApp are realistic swaps.
- **Your rules**: what runs unattended, what needs approval and what is blocked is one short, tested file.

How to do each: [docs/ADAPTING.md](docs/ADAPTING.md).

## Docs

| | |
|---|---|
| [Setup](docs/SETUP.md) | requirements, install, skills, daily use, tuning |
| [Safety](docs/SAFETY.md) | what it can and cannot do, and how that is enforced |
| [Architecture](docs/ARCHITECTURE.md) | how it works, project layout, development |
| [Adapting](docs/ADAPTING.md) | Proton and Mailbird, Gmail directly, other messengers, other tweaks |

## License

[MIT](LICENSE)
