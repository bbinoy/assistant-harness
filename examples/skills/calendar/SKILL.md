---
name: calendar
description: Use for reviewing the owner's Google Calendar - listing the day's / week's events, flagging conflicts and overlaps, proposing reschedule slots, and creating calendar events from travel bookings. Part of the daily brief; also for ad-hoc "what's my day / find me a slot / is X on my calendar". Pairs with [[mailbird]], [[meeting-prep]], [[daily-brief]].
---

# Calendar review

> TODO(owner): replace every `TODO(owner)` below with your own values, then delete this note.
> `npm run doctor` warns while any remain.

## Calendars

Google Calendar via MCP. Check all of these:
- TODO(owner): your primary calendar id (usually your email address)
- TODO(owner): any other calendar you want included

Calendars that are **not** connected (a work account whose calendar you
cannot add, for example) are invisible. Never assume the list is complete;
if a workday looks empty, say so.

Use `list_events` with an explicit start/end range and
`timeZone: "TODO(owner): your IANA time zone, e.g. Europe/Zurich"`. Call it
for **all calendars in the same turn** (they are independent).

## Window

- **Daily brief run:** today + tomorrow (forward), and back to the previous
  brief's send time (for the post-meeting pass handoff to [[meeting-prep]]).

Produce a clean event list for the window - time, title, attendees,
location - and hand it to [[meeting-prep]], which decides what needs prep.

## Conflicts and hygiene (flag in the brief, never fix)

- Overlapping events.
- Back-to-back meetings with no gap, especially across locations.
- A meeting that collides with travel, or with a task due that day.
- An external meeting with no agenda / no video link.
- A day that is wall-to-wall with no break.

## Reschedules (suggest only, never execute)

If an email asks to move a meeting, or two things clash, propose 2-3
concrete alternative slots from the owner's actual free time in the brief.
Do **not** call `update_event` on your own - the owner decides, then asks.

## Travel bookings -> calendar (the one automatic write)

Scan recent booking-confirmation emails (flights, trains, hotels,
buses) via [[mailbird]] `search_conversations`. For each **confirmed**
booking with a firm date/time that is **not already on the calendar**:

- `create_event` on the primary calendar: clear title ("Flight
  ZRH -> BCN LX123", "Hotel: <name>, <city>", "Train <A> -> <B>"),
  correct start/end (booking's own timezone, else the default above),
  location, and confirmation number + one-line summary in the
  description.
- Note each created event in the brief under "Changed by the assistant".
- Ambiguous booking (no firm time, possible duplicate): do not create -
  list it as "booking found, no calendar entry - add it?".

## Guardrails

- May: `create_event` for travel bookings as above.
- May not: `update_event` or reschedule on its own, `delete_event`
  ever, create non-travel events, edit other people's events, send or
  respond to invites.
- The agent's policy (`src/policy.ts`) also asks the owner on the phone
  before any calendar write, whatever this skill says.

## In the briefing

- **Conflicts / reschedules** section - only if there is something;
  each as a suggestion.
- Created travel events -> "Changed by the assistant".
- The meeting list itself is rendered by [[meeting-prep]].
