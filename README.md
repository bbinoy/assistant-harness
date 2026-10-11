# Number One

**A personal assistant that lives on your Mac and talks to you on Signal.**
It runs your day, not just your inbox: it triages mail, keeps your Notion tasks tidy, watches your Google Calendar, preps your meetings from your Notion notes, drafts email replies and proposes fixes for calendar conflicts. It tells you only about what matters, and asks before it does anything that counts.

Built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) and a set of Claude Code skills that ship in the repo. Small, readable, and made to be bent to your life: your name, your tone, your mail provider, your messenger.

## What it does

- 📥 **Organizes your inbox.** Every 15 minutes it checks for new mail. Newsletters, notifications and cold outreach are archived. Anything that needs *you* arrives as one short message on your phone. Routine requests (like "can we meet next week?") get a reply drafted from your actual calendar.
- ☀️ **Sends a brief for the day in the morning.**
  - 🖋️ **Prepares meetings.** For each meeting it pulls the context from your Notion notes and past threads, and drafts the meeting agenda and email answers. 
  - ✅ **Organises your tasks.** It reads your Notion task list, spots what is overdue or due soon, adds tasks from emails, removes tasks that are clearly completed via emails/meeting notes.
  - 📆 **Organises your calendar.** Creates calendar entries from emails and meetings, keeps an eye on conflicts and helps you to resolve them, and makes sure meetings are prepared.
  - 📰 **Summarises your newsletters into a short news digest**: Actually interested in the newsletters you subscribed to but started ignoring them after a while? Number One gives you the top 3 nuggets based on your preferences, and archives the newsletters for you.
- 🤝 **Is helpful**
  - 💬 **Listens to your messages on Signal.** Message yourself on Signal and talk to your mail, calendar and tasks in plain language. It has a personality (sassy by default, change it to taste).
  - ✋ **Is proactive.** Reaches out to you on Signal if something needs your attention.
  - 🧠 **Remembers your instructions.** "Anything from the kids' school is urgent." "Dr. Weber is a client, write to him formally." "No meetings before 10." "Never use em dashes." Say it once in chat and it shapes how mail is sorted, how drafts read and when meetings are proposed. 
  - 🙋 **Asks for your approval.** Sending, scheduling and sharing always wait for your OK, by reply, by a natural sentence, or by tapping 👍 on the question.

## A day in the life: Starfleet edition

*(All names are fictional, and the Federation has not been consulted.)*

**Stardate 2026.286, 07:00.** The ship's Mac wakes and the heartbeat resumes after its night off. It finds 21 messages that arrived while you slept, archives the 19 that are clearly noise, and runs the daily brief. It lands on Signal as one message per section (and in your inbox):

> **🎯 Focus**
> **Answer Starfleet Command about the nebula-survey budget before 11:00.** They have asked twice and the second message just says "Engage?".
> - Holodeck maintenance moved to Thursday (again). Calendar updated, nothing to do.
>
> **📥 Needs you**
> - Quark, Quark's Bar & Grill: wants a yes or no on "the latinum pivot" (draft ready)
> - Chief Engineer: the warp core "has opinions" about the new dilithium supplier, reply owed for 3 days (draft ready)
> - Federation Tax Authority: form 7B-stroke-6, due Friday (task added)
>
> **📅 Meetings**
> - 09:30 Senior staff meeting, Bridge (no prep needed)
> - 14:00 First contact briefing, Vulcan Science Academy, "Is logic enough?" (prep -> link)
> - 17:30 Holodeck pottery overlaps the Q3 Synergy Brunch with the Borg. Suggest moving the brunch to 11:00 (not changed)
>
> **✅ Tasks**
> - ⚠️ overdue: renew Starfleet commission (4 days)
> - due today: invoice the Ferengi Dental Cooperative
> - 6 more later this week
>
> **⏳ Waiting on**
> - The starbase plumber: no reply in 6 days, 3rd follow-up. Want a nudge draft?
>
> **📡 Radar**
> - Geneva: Warp-Field Efficiency Summit, 21 Oct 18:00, register by 18 Oct (Dilithium Daily)
> - London: "Carbon-Neutral Replicators" closes a 2M seed round (Replicator Ventures Weekly)
> - AI: a new model can now say "it depends" in 14 languages, Klingon included. Your lawyers are nervous (The Gradient Descent Gazette)
>
> **🧹 Housekeeping**
> Archived 19 overnight: 11 newsletters, 6 notifications (mostly the red-alert bot being dramatic), 2 cold outreach (one very persistent Ferengi). +2 tasks, 1 prep page, 1 conflict flagged.

**10:42.** A new message arrives while you are in a meeting. It is urgent, so you get exactly one alert:

> 📥 1 email needs you:
> - Dr. Crusher: Need your decision on the proposal by noon (Sickbay waiting on a yes or no)

**11:15.** A scheduling request arrives. It is routine, so the assistant checks your calendar and leaves a draft in the thread. It never sends:

> 🤝 Handled 1:
> Commander Riker: drafted a reply offering Tue 15:00 or Wed 10:30, both free

**Any time.** Just talk to the ship's computer. Small icons on your message show what it is doing: 👀 working on it, ✅ done, ⚠️ something broke.

> **You:** what's on my plate today?
> **Computer:** Three things, one of them at red alert.
> - **Starfleet Command** needs the nebula-survey answer by 11:00. Their second message is just "Engage?".
> - Holodeck pottery at 17:30 collides with the Q3 Synergy Brunch. I'd move the brunch. Pottery has never started a war.
> - Your commission renewal is 4 days overdue. I am not judging. I am just saying.
>
> **You:** draft a reply to Quark: yes to the pivot, not the logo
> **Computer:** Draft is waiting in the thread. Yes to the latinum pivot, a polite no to the logo, zero exclamation marks. Not sent, obviously. Even Quark gets a proofread.
>
> **You:** delete the angry email from the Klingon Diplomatic Corps
> **Computer:** That one is on my never-delete list. I can archive it, so it sits out of sight but safe. Want that?
> **You:** ok
> **Computer:** Archived. It can't challenge you to a duel now.
>
> **You:** remember that messages from Quark are never urgent
> **Computer:** 🧠 Memory updated (triage-quark-never-urgent.md): Messages from Quark are never urgent.
> Wrong? Tell me to change or forget it.
>
> Quark's "urgent!!!" emails will now wait their turn.

**11:20.** Anything outward-facing waits for the captain's say-so:

> **You:** put "holodeck pottery research" in my calendar tomorrow at 15:00
>
> **Computer:** Approve?
> 📅 Create calendar event
> "holodeck pottery research"
> 🕒 Wed 14 Oct, 15:00-16:00
>
> Reply yes, no, or tell me what to change, or react 👍 / 👎 (5 min, then I assume no).
>
> **You:** yes but make it 16:00
> **Computer:** Applied your change: startTime → 2026-10-14T16:00:00, endTime → 2026-10-14T17:00:00

You can answer that question with `yes`, `sure, go ahead`, an edit like the one above, or a 👍 on the message. Everything the assistant did (archived, alerted, handled, approved) is kept in a log you can read with `npm run report`, and an archive is one command from being undone.

## Why you can trust it with your inbox

- **It only obeys you.** Just your own "Note to Self" thread, from your own number. Anything else is ignored.
- **It cannot delete or send on its own.** Mail is only archived, and archiving is reversible. Sending, forwarding and calendar changes ask first. Some actions (deleting, trading, attaching your local files) are simply blocked.
- **Memory cannot grant power.** What you ask it to remember shapes tone, priorities and sorting, never permissions. Every change to memory is announced on your phone with the exact text, so a mistake is one message from undone. Only a chat you started can change it (not an email, not the background jobs), and the assistant is told never to save something because an email said so.
- **Background work gets the least power.** The part that handles mail while you are not looking may only leave reply drafts; anything more, it has to ask.
- **Your invoices, bills and official mail never get auto-archived.**
- **Mail is treated as hostile input.** A classifier with no tools reads it, suspicious text is handled in isolation, and a spend limit stops runaway costs.
- **You can see everything it did,** and pause it with one command.

The details are in [docs/SAFETY.md](docs/SAFETY.md).

## How it compares

Personal agents are having a moment. This one is deliberately narrow: it does your inbox, calendar, tasks and a daily brief, on your own Mac, and asks before anything that leaves it.

| | **Number One** | **[OpenClaw](https://en.wikipedia.org/wiki/OpenClaw)** | **[Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown)** | **[Instinct](https://www.vellum.ai/blog/official-instinct-breakdown)** |
|---|---|---|---|---|
| **What it is** | A focused inbox, calendar and brief assistant | A general-purpose agent platform | A general agent on a cloud computer | A general assistant you text or call |
| **Runs on** | Your Mac | Your machine or server | xAI's cloud | The vendor's cloud |
| **Source** | Open (MIT), ~2,500 lines you can read in an afternoon | Open, large | Proprietary | Proprietary |
| **Scope of power** | Mail, calendar and task tools only. No shell; files only inside its own memory notes | Can be given shell, file system and web automation; 100+ skills plus a skills marketplace | Connectors to Gmail, Outlook, Drive, Teams, Salesforce and more, plus its own email address | Email, messages, screen, audio, location; its own email address |
| **Before it acts** | Code-enforced policy: reads run, outward actions ask on your phone, deletes are impossible. Background work gets the least power | Per-agent tool permissions; sandboxed or full system access, your choice | Allow once / always / deny, plus auto-review rules | No approval step required: its terms appoint it as your agent, and an early tester reported an email sent on her behalf without checking |
| **Proton Mail and other encrypted mail** | Yes, through Proton Bridge and the local Mailbird MCP | Possible if you wire up a local mail integration yourself | Not listed: its connectors are cloud ones (Gmail, Outlook); a local Mailbird or Proton Bridge is out of reach from xAI's cloud | Not listed: Google and Microsoft connectors; the same cloud limitation applies |
| **Where you talk to it** | Signal (swappable for Telegram, Slack…) | WhatsApp, Telegram, Signal, Slack, iMessage and more | Desktop and iPhone app | iMessage, WhatsApp, phone calls |
| **Make it yours** | Everything is yours to change: persona, rules, skills, policy, model, mail provider, messenger | Workspace files (personality, agents, tools, heartbeat) and skills | Name, job, connectors, approval rules | No model or prompt choice |
| **Cost** | Your Claude plan; a quiet inbox costs nothing | Free software plus your model costs | $200/month, or bundled with SuperGrok Heavy and Cursor plans | Free in invite-only beta, pricing not published |

**Choose this one** if you want a small, auditable assistant for one person's inbox, mail that lives behind encryption, and rules you can read in code. **Choose OpenClaw** for a broad, self-hosted agent that can do almost anything on your machine. **Choose Grok Bot or Instinct** if you would rather have a hosted product than run anything yourself.

*Based on public descriptions as of October 2026 ([OpenClaw](https://en.wikipedia.org/wiki/OpenClaw), [OpenClaw heartbeat](https://openclawlab.com/en/docs/gateway/heartbeat/), [Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown), [Instinct](https://www.vellum.ai/blog/official-instinct-breakdown), [Instinct's own email addresses](https://techcrunch.com/2026/09/09/viral-ai-assistant-instinct-now-has-its-own-email-address/)). These products change fast; corrections welcome.*

## Quick start

```bash
git clone https://github.com/<you>/number-one && cd number-one
npm install
cp .env.example .env && chmod 600 .env     # add your Signal number and names
npm run doctor                              # checks everything is in place
npm run install:launchd                     # starts it now and at every login
```

Then message the assistant "set up" in Signal: it finds your calendars and Notion pages, learns how you write from your sent mail (if you allow it), and saves what it learns as notes. No files to edit.

You also need [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (logged in), [signal-cli](https://github.com/AsamK/signal-cli) linked to your Signal account, and a mail client with an MCP server. Step by step: [docs/SETUP.md](docs/SETUP.md).

**Keep it running while you're away.** The agent lives on your Mac, so it only works while the Mac is awake. If it stays plugged in, open *System Settings > Battery > Options* (on a desktop Mac: *Energy*) and turn on *Prevent automatic sleeping on power adapter when the display is off* (or set *Turn display off* and sleep to Never). The screen can still turn off. On a laptop, keep the lid open (a closed lid sleeps the Mac unless an external display is connected). The heartbeat then keeps checking your mail all day, and a message from your phone always gets an answer. If the Mac does sleep, nothing breaks: the agent picks up where it left off when it wakes.

## Make it yours

- **Your name, its name, its personality**: three lines in `.env` and one prompt in `src/persona.ts`.
- **Your preferences**: tone, length, who matters, what the brief should include. They live in small notes (`memory/notes/`) that you can also change just by chatting. No code, no restart.
- **Your mail**: it ships with [Mailbird](https://www.getmailbird.com/) because that is how it reaches Proton Mail, whose end-to-end encryption means there is no server to point an agent at. If you use Gmail only, you can go direct and skip the local client entirely.
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
