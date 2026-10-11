---
name: notion-tasks
description: Use when reviewing, tidying, or updating the owner's Notion task list, keeping it in sync with email activity, or reporting on tasks - typically as part of the daily brief, or an ad-hoc "what's on my list / add a task / mark this done". Pairs with [[mailbird]] and [[daily-brief]].
---

# Notion task list

> TODO(owner): replace every `TODO(owner)` below with your own values, then delete this note.
> `npm run doctor` warns while any remain.

**Page:** TODO(owner): the URL of your task page in Notion
(id `TODO(owner): the page id`). This template assumes a **page** with two
Markdown tables, `## 📅 Due` and `## 📋 Later`, with columns
Task / Due / Priority / Area. Edit it with `notion-update-page`
(`update_content` search-replace on the table rows). If you keep tasks in a
database instead, rewrite this skill around `notion-create-pages` and
`notion-update-page` on that database. (The agent only sees four Notion tools:
search, fetch, create-pages and update-page. See `NOTION_TOOLS` in `.env.example`.)

**Fetch it once.** One `notion-fetch` on the page at the start of the
tasks step; make all edits from that copy. Re-fetch at most once, only
to verify a complex multi-row rewrite. Never fetch it 2-3 times.

## Always do first (the page's own standing instructions)

Put an instruction block for AI assistants on the page itself and follow it
every run. A good default:

- Remove tasks that are done.
- Move a row from **Later** to **Due** once its date is today or past;
  move Due -> Later if its date was pushed to the future.
- Sort each table by date ascending, then priority.
- Prefix a task with `⚠️` if it is overdue (date < today).
- Fix any inconsistencies (missing sort, stale ⚠️, wrong section).

Priority tokens: `🔴 High` `🟡 Medium` `🟢 Low`. Area tokens: `💼 Work`
`🏠 Private`. Keep them exact (change them to your own).

## Email <-> task sync

Only when the link is unambiguous:

- **Mark done / remove** when email activity clearly completes a task:
  task is "reply to / send X to <person>" and the owner has since sent that
  mail; task is "sign <doc>" and a signed / countersigned confirmation
  arrived. Remove the row (per the standing instruction to delete done
  tasks) and note it in the brief.
- **Add a task** when an incoming email creates a clear obligation with
  a deadline or promised deliverable and no matching row exists. Put a
  source hint in the task text, e.g. "(from <sender>, <date>)". Default
  Area from context, Priority 🟡 unless clearly urgent.
- **Nudge** when a task is "waiting on <person>" past its date and no
  reply has come: surface it in the brief with a draft follow-up (via
  [[mailbird]]), do not auto-send.

When the link is fuzzy, do **not** edit - list it in the brief as a
question ("looks like 'Foo' may be done - confirm?").

## Guardrails

- May: add rows, edit a row's Task / Due / Priority / Area, move rows
  between the two tables, remove done rows, re-sort, fix ⚠️.
- May not: delete the page or a table, change the page structure.
- Never remove a task as "done" without concrete evidence. In doubt,
  keep it and ask in the brief.
- Preserve the owner's own wording in task titles; keep any edits minimal.

## Deadlines are tasks

Keep it simple: every deadline lives here as a task row. When
[[mailbird]] or [[meeting-prep]] surface a date-bound thing (payment
due, RSVP-by, sign-by, respond-by, application deadline, memo due, doc
to sign) and no matching row exists, add one with its Due date and a
short source hint. There is no separate deadline list - the Tasks
section of the brief, ordered by date, is the deadline view.

## In the briefing

A **Tasks** section: `⚠️ Overdue` first (with how many days), then
**Due today**, then **Due this week** (dated), then a one-line count of
everything later. Call out every row the run changed and why (moved /
added / removed / nudged).
