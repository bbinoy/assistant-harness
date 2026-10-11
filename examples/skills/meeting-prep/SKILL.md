---
name: meeting-prep
description: Use when deciding which upcoming meetings need preparation, creating and drafting a prep page in the owner's Notion "Meetings" database, and running the post-meeting follow-up pass. Part of the daily brief. Gets the event list from [[calendar]]; pairs with [[mailbird]], [[notion-tasks]], [[daily-brief]].
---

# Meeting prep

> TODO(owner): replace every `TODO(owner)` below with your own values, then delete this note.
> `npm run doctor` warns while any remain.

[[calendar]] produces the reviewed event list for the window. This skill
decides what needs prep, drafts it, and follows up after meetings happen.

## Which meetings need prep

**Needs prep** - a substantive external or high-stakes meeting: an
intro / pitch / customer or investor call, an interview, a presentation,
a decision meeting, anything with an agenda or pre-read.

**No prep** - 1:1 personal catch-ups, standups / recurring team syncs,
socials, blocked focus time, travel, all-day markers.

If unsure, treat it as needs-prep but keep the draft short.

## Meetings database

**DB:** TODO(owner): the URL of your Meetings database in Notion
data source `collection://TODO(owner): its data source id`.
Schema: `Meeting name` (title), `Date` (date/datetime), `Category`
(multi-select), `Summary` (text), body = the prep / notes. Default template
"TODO(owner): your template name" (`TODO(owner): its id`, or drop the
template step if you have none).

Read it with **one** `notion-fetch` on the "All Meetings" view URL
(TODO(owner): that view's URL). Do not fetch it again, do not also fetch
the `collection://` data source. (`query-data-sources` is not among the four
Notion tools the agent sees, see `NOTION_TOOLS` in `.env.example`.)

## Per meeting that needs prep

Do the deep build **only** when: the meeting is in the window, it needs
prep, and there is **no existing row with real prep content**. If a row
already has a decent prep body, just link it and move on - do not
rebuild or re-research.

1. **Look for an existing row** - match on meeting name / attendee and a
   `Date` within a day of the event.
2. **If none, create one** (`create-pages`, parent
   `data_source_id: TODO(owner): the data source id`, apply your template):
   set `Meeting name`, `Date` (`is_datetime` 1, real start time),
   best-guess `Category`.
3. **Draft the prep in the body** from a *bounded* look:
   - at most the **2 most recent** prior rows in this DB with the same
     person / company (their `Summary` first; open a body only if the
     Summary is thin);
   - at most the **2 most recent** email threads with the attendee -
     one [[mailbird]] `search_conversations`, skim the result, open at
     most those two;
   - any single doc the invite directly links.
   Structure: **Context** (who they are, how the owner knows them, last
   contact), **Goal**, **Talking points / questions** (3-6), **Open
   threads / asks**, **Prep to do** (if any - also add it to
   [[notion-tasks]]).
4. Put a short version + the Notion link in the briefing.

## Post-meeting follow-up (every run)

For meetings that already happened in the look-back window:

1. Find the Meetings DB row (by name / attendee / date).
2. **If it has real notes / a Summary:** read them, pull out follow-ups
   (a promise the owner made, a next step, a doc to send). For each, add a
   task to [[notion-tasks]] if none exists and list it in the brief;
   draft any follow-up email in-thread via [[mailbird]].
3. **If there are no notes:** in the brief, ask "add notes from your
   <meeting> with <person>?" and, if the meeting type usually needs a
   follow-up, suggest a placeholder task.

## Guardrails

- May: create meeting rows, set their properties, write / update prep
  body content, add a matching task via [[notion-tasks]].
- May not: delete meeting rows, touch the calendar (that is [[calendar]]),
  send invites, change other people's notes.
- Draft only - never email an attendee or share prep without the owner.

## In the briefing

- **Meetings** section: today and tomorrow, each one
  line - time, title, attendee, and "prep ready -> <link>" or "no prep
  needed". The daily brief carries the full short pre-meeting packet
  for each of the day's meetings that need prep. Flag same-day
  deadlines (memo due, doc to sign) at the top.
- **Follow-ups** section: from the post-meeting pass - notes to add,
  follow-up tasks created, drafts waiting.
