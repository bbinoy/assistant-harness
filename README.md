# Ted

**A personal assistant that lives on your Mac and talks to you on Signal.**
It runs your day, not just your inbox: it triages mail, keeps your Notion tasks tidy, watches your Google Calendar, preps your meetings from your Notion notes, drafts email replies and proposes fixes for calendar conflicts. It tells you only about what matters, and asks before it does anything that counts.

Built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) and a set of Claude Code skills that ship in the repo. Small, readable, and made to be bent to your life: your name, your tone, your mail provider, your messenger.

## What it does

- 📥 **Organizes your inbox.** Every 15 minutes it checks for new mail. Newsletters, notifications and cold outreach are archived. Anything that needs *you* arrives as one short message on your phone. Routine requests (like "can we meet next week?") get a reply drafted from your actual calendar, shown on your phone, and sent when you reply "send" and approve.
- ☀️ **Sends a brief for the day in the morning**, in full by email and as a short pep talk plus focus on Signal.
  - 🖋️ **Prepares meetings.** For each meeting it pulls the context from your Notion notes and past threads, and drafts the meeting agenda and email answers. 
  - ✅ **Organises your tasks.** It reads your Notion task list, spots what is overdue or due soon, adds tasks from emails, removes tasks that are clearly completed via emails/meeting notes.
  - 📆 **Organises your calendar.** Creates calendar entries from emails and meetings, keeps an eye on conflicts and helps you to resolve them, and makes sure meetings are prepared.
  - 📰 **Summarises your newsletters into a short news digest**: Actually interested in the newsletters you subscribed to but started ignoring them after a while? Ted gives you the top 3 nuggets based on your preferences, and archives the newsletters for you.
- 🤝 **Is helpful**
  - 💬 **Listens to your messages on Signal.** Chat with it like a contact (or add it to a group chat, where it joins in when addressed or when it fits, with its own memory and conversation per group and no access to your private data; it shows "typing…" as soon as it has decided to answer, and keeps model processes warm for a fast start, `WARM` and `WARM_IDLE_MINUTES`) and talk to your mail, calendar and tasks in plain language. **Recommended: give it its own Signal account** (a name, a picture, "typing…" while it works; [how, in 10 minutes](docs/SIGNAL-ACCOUNT.md)). It feels far more like talking to an assistant than messaging yourself, which is what the zero-setup default (Signal's *Note to Self*) does. It has a personality (warm, folksy and relentlessly optimistic, in the style of Ted Lasso, by default; change it to taste).
  - ✋ **Is proactive.** Reaches out to you on Signal if something needs your attention: urgent mail right away, and every couple of hours a look at your calendar for meetings about to start (with their prep) and clashes.
  - 🧠 **Remembers your instructions.** "Anything from the kids' school is urgent." "Dr. Weber is a client, write to him formally." "No meetings before 10." "Never use em dashes." Say it once in chat and it shapes how mail is sorted, how drafts read and when meetings are proposed. Overnight it also reviews what you told it, saves what is worth remembering (people, life events, projects, preferences) and tidies old notes, silently (it is logged, and you can say "undo the dream"). 
  - 🙋 **Asks for your approval.** Sending, scheduling and sharing always wait for your OK, by reply, by a natural sentence, or by tapping 👍 on the question.

## A day in the life: AFC Richmond edition

*(Characters borrowed with love from Ted Lasso. Nobody at Richmond has been consulted, though Roy would say it's "bloody fine, I suppose.")*

**Tuesday, 07:00.** Your Mac wakes and the heartbeat resumes after its night off. It finds 21 messages that arrived while you slept, archives the 19 that are clearly noise, and, because your chat's gate sees no brief in its log yet, starts the daily brief (if the gate ever stays silent, code starts it at 09:00 anyway, and retries it if it comes out incomplete). The full brief lands in your inbox. On Signal you get the short version, with the pep talk first:

> **💪 Pep talk**
> Mornin', Coach! Now, I know the inbox looks like a pile of angry geese, but today is really just three things, and you've handled worse before your first biscuit. Be a goldfish about the rest. Answer the Board before 11:00 and everything else is a nice, easy warm-up.
>
> **🎯 Focus**
> **Answer Rebecca about the stadium budget before 11:00.** She's asked twice, and the second message just says "Ted. Budget."
> - Press conference prep at 14:00, the prep page is ready.
> - Ring the boiler repairman. Again. That man is harder to reach than a Roy Kent smile.
>
> 📧 The full brief is in your email. Say "brief" and I'll send it here.

The email has the rest, kept to the day ahead:

> **📥 Needs you**
> - Rebecca Welton: wants a yes or no on "the sponsorship pivot" (draft ready)
> - Coach Beard: the new training schedule "has opinions" about Thursday, reply owed for 3 days (draft ready)
> - Premier League Compliance: form 7B-stroke-6, due Friday (task added)
>
> **📅 Today**
> - 09:30 Diamond Dogs stand-up (no prep needed)
> - 14:00 Press conference, "Is belief enough?" (prep -> link)
> - 17:30 Dani's kickball clinic overlaps the Q3 Sponsors' Brunch. Suggest moving the brunch to 11:00 (not changed)
> - Tomorrow: 08:30 Locker room team talk
>
> **✅ Tasks**
> - ⚠️ overdue: renew your coaching licence (4 days)
> - due today: invoice the Dubai Air sponsorship (they're very nice about it, which is worrying)
> - 6 more this week, 8 later
>
> **⏳ Waiting on**
> - The boiler repairman: no reply in 6 days, 3rd follow-up. Want a nudge draft?
>
> **📡 Radar**
> - Lisbon: Football Analytics Summit, 21 Oct 18:00, register by 18 Oct (The Tactics Weekly)
> - London: a biscuit-delivery startup closes a 2M seed round (Snack Ventures Weekly)
> - AI: a new model can now say "it depends" in 14 languages, Welsh included. Your lawyers are nervous (The Gradient Descent Gazette)
>
> **🧹 Housekeeping**
> I archived 19 overnight: 13 newsletters and cold outreach (one very persistent salesman who wanted to sell AFC Richmond a "synergy-based pitch"), plus the stadium app's weekly digest, a kit-delivery notice, the team bus receipt, Keeley's accepted calendar invite, and four more cheerful pings from the laundry system. +2 tasks, 1 prep page, 1 conflict flagged, nothing deleted by me.

**10:42.** A new message arrives while you are in a meeting. It is urgent, so you get exactly one alert:

> 📥 1 email needs you:
> - Keeley Jones: Need your decision on the PR plan by noon (the whole campaign is waiting on a yes or no)

**11:15.** A scheduling request arrives. It is routine, so the assistant checks your calendar and leaves a draft in the thread. It never sends:

> 🤝 Handled 1:
> Roy Kent: drafted a reply offering Tue 15:00 or Wed 10:30, both free (he'd like it "quick and without any bloody small talk")

**Whenever something is due.** Every conversation, yours and each group Ted is in, gets a look from a small model on every heartbeat tick once its "next look" time has come, or when something was said or a note changed since: it reads the clock, the notes and the tail of the log and decides whether to do anything on its own. So a note like "every morning post a fun fact" or "nudge us on Friday" works in your chat and in a group, and "don't reply so fast" changes the pace. Silent at night (your chat), and it may still decide to say nothing. The same gate decides when the daily brief and the radar run (default rules: brief once in the morning, radar every few hours and before meetings; a note such as "brief at 6:30" or "no radar on weekends" changes them), while code keeps how they run. `SCHEDULER=legacy` goes back to the fixed schedules. Group wake-ups run with the group's rights only; yours with the radar's (reads and web search; anything else asks on your phone).

**Any time.** Just talk to Ted, in text or in a voice note (transcribed on your Mac, nothing leaves it), and it may answer with a voice message of its own whenever that fits (a pep talk, a joke; never for times and figures) in a voice you pick, generated locally (or, if you opt in, by ElevenLabs or a server of your own: [REMOTE-TTS.md](docs/REMOTE-TTS.md)), in your chat and in groups alike. Tell it in a note if you want more or less of that. Send a photo (with or without a caption) and Ted looks at it, in your chat and in groups alike: JPEG, PNG, WebP, GIF or an iPhone HEIC, shrunk on your Mac first to keep it cheap; other files and videos are skipped. While it works you see "typing…", and sometimes it answers with just an emoji on your message. (In Note to Self, which has no typing indicator, small icons show the state instead: 👀 working, ✅ done, ⚠️ broke.)

> **You:** what's on my plate today?
> **Ted:** Three things, and not one of them is a lion! 🦁
> - **Rebecca** wants an answer on the budget by 11:00. Her second message is just "Ted. Budget."
> - Kickball clinic at 17:30 collides with the Sponsors' Brunch. I'd move the brunch. Nobody ever won a championship over a quiche.
> - Your coaching licence is 4 days overdue. No judgment here, buddy. Just a gentle nudge, like a friendly goat.
>
> **You:** draft a reply to Rebecca: yes to the pivot, not the logo
> **Ted:** Draft's waiting in the thread. Yes to the sponsorship pivot, a kind no to the logo (it looked a little like a sad pie), zero exclamation marks. Not sent, of course. Even the boss gets a proofread.
>
> **You:** delete the angry email from the Tottenham fan club
> **Ted:** That one's on my never-delete list. I can archive it though, so it's out of sight but safe, like a shy turtle. Want that?
> **You:** ok
> **Ted:** Archived. It can't yell at you now.
>
> **You:** remember that messages from Jamie are never urgent
> **Ted:** Saved: Jamie's "URGENT!!!" emails will now wait their turn. Which, between you and me, is a long line.

**11:20.** Plain things on your own calendar just happen, and you are told. Anything that involves other people waits for your say-so:

> **You:** put "find a decent cup of tea" in my calendar tomorrow at 15:00
> **Ted:** ✅ Done without asking: 📅 Create calendar event "find a decent cup of tea", Wed 14 Oct, 15:00-16:00
>
> **You:** and invite Coach Beard to it
>
> **Ted:** Approve?
> 📅 Change calendar event
> "find a decent cup of tea"
> 👥 Coach Beard
>
> Reply yes, no, or tell me what to change, or react 👍 / 👎 (15 min, then I assume no).
>
> **You:** yes but make it 16:00
> **Ted:** Applied your change: startTime → 2026-10-14T16:00:00, endTime → 2026-10-14T17:00:00

You can answer that question with `yes`, `sure, go ahead`, an edit like the one above, or a 👍 on the message. Everything the assistant did (archived, alerted, handled, approved) is kept in a log you can read with `npm run report`, and an archive is one command from being undone.

## Why you can trust it with your inbox

- **It only obeys you.** Just your own number, in your private chat with it (your "Note to Self", or its own Signal chat with you). Groups and everyone else are ignored.
- **It cannot delete or send on its own.** Mail is only archived, and archiving is reversible. Sending, forwarding and calendar changes ask first. Some actions (deleting, trading, attaching your local files) are simply blocked.
- **Memory cannot grant power.** What you ask it to remember shapes tone, priorities and sorting, never permissions. Every change to memory is mentioned in the assistant's reply, so a mistake is one message from undone. Only a chat you started can change it (not an email, not the background jobs), and the assistant is told never to save something because an email said so.
- **Background work gets the least power.** The part that handles mail while you are not looking may only leave reply drafts; anything more, it has to ask.
- **Archiving is judged by intent and reviewed by you.** The classifier archives only what leaves nothing to do (receipts, status notices, newsletters), keeps anything with an open question, a payment or a person waiting, and every archived mail is listed with the reason in the morning brief, one command from being restored.
- **Mail is treated as hostile input.** A classifier with no tools reads it, suspicious text is handled in isolation, and a spend limit stops runaway costs.
- **You can see everything it did,** and pause it with one command.

The details are in [docs/SAFETY.md](docs/SAFETY.md).

## How it compares

Personal agents are having a moment. This one is deliberately narrow: it does your inbox, calendar, tasks and a daily brief, on your own Mac, and asks before anything that leaves it.

| | **Ted** | **[OpenClaw](https://en.wikipedia.org/wiki/OpenClaw)** | **[Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown)** | **[Instinct](https://www.vellum.ai/blog/official-instinct-breakdown)** |
|---|---|---|---|---|
| **What it is** | A lean inbox, calendar and daily standup assistant built on [Mailbird](https://www.getmailbird.com/) MCP locally | A general-purpose agent platform | A general agent on a cloud computer | A general assistant you text or call |
| **Comes with existing personal assistant skills** | Yes: daily brief, mail triage and drafting, calendar review, Notion tasks, meeting prep and a guided setup, ready to use | Not listed as a bundle: 100+ general skills and a marketplace | Not listed | Not listed |
| **Proton Mail and other encrypted mail** | Yes, through Proton Bridge and the local Mailbird MCP | Possible if you wire up a local mail integration yourself | Not listed: its connectors are cloud ones (Gmail, Outlook); a local Mailbird or Proton Bridge is out of reach from xAI's cloud | Not listed: Google and Microsoft connectors; the same cloud limitation applies |
| **Before it acts** | Code-enforced policy: reads run, outward actions ask on your phone, deletes are impossible. Background work gets the least power | Per-agent tool permissions; sandboxed or full system access, your choice | Allow once / always / deny, plus auto-review rules | No approval step required: its terms appoint it as your agent, and an early tester reported an email sent on her behalf without checking |
| **Scope of power** | Mail, calendar and task tools, plus web search (opening a page asks first). No shell; files only inside its own memory notes | Can be given shell, file system and web automation; 100+ skills plus a skills marketplace | Connectors to Gmail, Outlook, Drive, Teams, Salesforce and more, plus its own email address | Email, messages, screen, audio, location; its own email address |
| **Source** | Open (MIT), ~3,000 lines you can read in an afternoon | Open, large | Proprietary | Proprietary |
| **Cost** | Your Claude plan: roughly a dollar for the daily brief, cents per chat message, nothing while the inbox is quiet | Free software plus your model costs | $200/month, or bundled with SuperGrok Heavy and Cursor plans | Free in invite-only beta, pricing not published |
| **Runs on** | Your Mac | Your machine or server | xAI's cloud | The vendor's cloud |
| **Make it yours** | Everything is yours to change: persona, rules, skills, policy, model, mail provider, messenger | Workspace files (personality, agents, tools, heartbeat) and skills | Name, job, connectors, approval rules | No model or prompt choice |
| **Where you talk to it** | Signal (swappable for Telegram, Slack…) | WhatsApp, Telegram, Signal, Slack, iMessage and more | Desktop and iPhone app | iMessage, WhatsApp, phone calls |

**Choose this one** if you want a small, auditable assistant for one person's inbox, mail that lives behind encryption, and rules you can read in code. **Choose OpenClaw** for a broad, self-hosted agent that can do almost anything on your machine. **Choose Grok Bot or Instinct** if you would rather have a hosted product than run anything yourself.

*Based on public descriptions as of October 2026 ([OpenClaw](https://en.wikipedia.org/wiki/OpenClaw), [OpenClaw heartbeat](https://openclawlab.com/en/docs/gateway/heartbeat/), [Grok Bot](https://www.vellum.ai/blog/official-grok-bot-breakdown), [Instinct](https://www.vellum.ai/blog/official-instinct-breakdown), [Instinct's own email addresses](https://techcrunch.com/2026/09/09/viral-ai-assistant-instinct-now-has-its-own-email-address/)). These products change fast; corrections welcome.*

## Quick start

```bash
git clone https://github.com/<you>/ted-personal-assistant && cd ted-personal-assistant
npm install
cp .env.example .env && chmod 600 .env     # add your Signal number and names
npm run doctor                              # checks everything is in place
npm run install:launchd                     # starts it now and at every login
```

**Strongly recommended:** give the assistant its own Signal account before you start, so you chat with a contact instead of with yourself: [docs/SIGNAL-ACCOUNT.md](docs/SIGNAL-ACCOUNT.md) (a spare number, or Signal Login on Android with no number). Without it, everything works in Note to Self.

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
