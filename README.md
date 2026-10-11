# Ben-E

**A personal assistant that lives on your Mac and talks to you on Signal.**
It watches your inbox so you don't have to, handles the boring parts, tells you only about what matters, and asks before it does anything that counts.

Built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) and your own Claude Code skills. Small, readable, and made to be bent to your life: your name, your tone, your mail provider, your messenger.

## What it does

- 📥 **Your inbox, handled.** Every 15 minutes it checks for new mail. Newsletters, notifications and cold outreach are archived. Anything that needs *you* arrives as one short message on your phone. Routine requests (like "can we meet next week?") get a reply drafted from your actual calendar.
- ☀️ **A daily brief that remembers yesterday.** Once a day it reads your mail, tasks and calendar, preps your meetings, and sends one brief to your inbox and your phone, one message per section.
- 💬 **A chat that can actually do things.** Message yourself on Signal and talk to your mail, calendar and tasks in plain language. It has a personality (sassy by default, change it to taste).
- 🙋 **It asks first.** Sending, scheduling and sharing always wait for your OK, by reply, by a natural sentence, or by tapping 👍 on the question.

## A day in the life

*(All names below are fictional.)*

**07:00.** The Mac wakes and the heartbeat resumes after its night off. It finds 21 emails that arrived overnight, archives the 19 that are clearly noise, and runs the daily brief. It lands on Signal as one message per section (and in your inbox):

> **🎯 Focus**
> **Answer Prof. Quibblesworth about the pigeon-detection grant before 11:00.** She has asked twice and the second email just says "?".
> - Dentist moved to Thursday (again). Calendar updated, nothing to do.
>
> **📥 Needs you**
> - Mortimer, Acme Yoghurt Labs: wants a yes or no on "the probiotic pivot" (draft ready)
> - Landlord: the cat "has opinions" about the new sofa, reply owed for 3 days (draft ready)
> - Tax office: form 7B-stroke-6, due Friday (task added)
>
> **📅 Meetings**
> - 09:30 Standup, Rubber Duck Debugging Guild (no prep needed)
> - 14:00 Pitch to Bartholomew Capital, "Uber for umbrellas" (prep -> link)
> - 17:30 Pottery overlaps the Q3 Synergy Brunch. Suggest moving the brunch to 11:00 (not changed)
>
> **✅ Tasks**
> - ⚠️ overdue: renew passport (4 days)
> - due today: invoice the Llama Dental Cooperative
> - 6 more later this week
>
> **⏳ Waiting on**
> - The plumber: no reply in 6 days, 3rd follow-up. Want a nudge draft?
>
> **📡 Radar**
> - Zurich: Alpine Cheese-Tech Meetup, 21 Oct 18:00, register by 18 Oct (Fondue Futures Weekly)
> - London: "Carbon-Neutral Croissants" closes a 2M seed round (Bakery Ventures Weekly)
> - AI: a new model can now say "it depends" in 14 languages. Your lawyers are nervous (The Gradient Descent Gazette)
>
> **🧹 Housekeeping**
> Archived 19 overnight: 11 newsletters, 6 notifications (mostly a CI bot being dramatic), 2 cold outreach. +2 tasks, 1 prep page, 1 conflict flagged.

**10:42.** A new email arrives while you are in a meeting. It is urgent, so you get exactly one message:

> 📥 1 email needs you:
> - Dr. Fennimore: Need your decision on the proposal by noon (client waiting on a yes or no)

**11:15.** A scheduling request arrives. It is routine, so the assistant checks your calendar and leaves a draft in the thread. It never sends:

> 🤝 Handled 1:
> Anna Keller: drafted a reply offering Tue 15:00 or Wed 10:30, both free

**Any time.** Just talk to it. Small icons on your message show what it is doing: 👀 working on it, ✅ done, ⚠️ something broke.

> **You:** what's on my plate today?
> **Ben-E:** Three things, one of them loud.
> - **Prof. Quibblesworth** needs the pigeon-grant answer by 11:00. Her second email is just "?".
> - Pottery at 17:30 collides with the Q3 Synergy Brunch. I'd move the brunch. Pottery has never wasted anyone's time.
> - Passport renewal is 4 days overdue. I am not judging. I am just saying.
>
> **You:** draft a reply to Mortimer: yes to the pivot, not the logo
> **Ben-E:** Draft is waiting in the thread. Yes to the probiotic pivot, a polite no to the logo, zero exclamation marks. Not sent, obviously.
>
> **You:** delete the angry email from the landlord
> **Ben-E:** That one is on my never-delete list. I can archive it, so it sits out of sight but safe. Want that?
> **You:** ok
> **Ben-E:** Archived. It can't hurt you now.

**11:20.** Anything outward-facing waits for your say-so:

> **You:** put "pottery glaze research" in my calendar tomorrow at 15:00
>
> **Ben-E:** Approve?
> 📅 Create calendar event
> "pottery glaze research"
> 🕒 Wed 14 Oct, 15:00-16:00
>
> Reply yes, no, or tell me what to change, or react 👍 / 👎 (5 min, then I assume no).
>
> **You:** yes but make it 16:00
> **Ben-E:** Applied your change: startTime → 2026-10-14T16:00:00, endTime → 2026-10-14T17:00:00

You can answer that question with `yes`, `sure, go ahead`, an edit like the one above, or a 👍 on the message. Everything the assistant did (archived, alerted, handled, approved) is kept in a log you can read with `npm run report`, and an archive is one command from being undone.

## Why you can trust it with your inbox

- **It only obeys you.** Just your own "Note to Self" thread, from your own number. Anything else is ignored.
- **It cannot delete or send on its own.** Mail is only archived, and archiving is reversible. Sending, forwarding and calendar changes ask first. Some actions (deleting, trading) are simply blocked.
- **Your invoices, bills and official mail never get auto-archived.**
- **Mail is treated as hostile input.** A classifier with no tools reads it, suspicious text is handled in isolation, and a spend limit stops runaway costs.
- **You can see everything it did,** and pause it with one command.

The details are in [docs/SAFETY.md](docs/SAFETY.md).

## Quick start

```bash
git clone https://github.com/<you>/assistant-harness && cd assistant-harness
npm install
cp .env.example .env && chmod 600 .env     # add your Signal number and names
npm run doctor                              # checks everything is in place
npm run install:launchd                     # starts it now and at every login
```

You also need [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) (logged in), [signal-cli](https://github.com/AsamK/signal-cli) linked to your Signal account, and a mail client with an MCP server. Step by step: [docs/SETUP.md](docs/SETUP.md).

## Make it yours

- **Your name, its name, its personality**: three lines in `.env` and one prompt in `src/persona.ts`.
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

## Honest status

A personal project that runs daily for its author. It works, its safety-critical logic is unit-tested, and it is opinionated. It is **macOS only**, built for **one user**, and it works only while your Mac is awake. Read the code before trusting it with your inbox, and check Anthropic's current terms for using your plan this way.

## License

[MIT](LICENSE)
