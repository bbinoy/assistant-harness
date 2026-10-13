# Plan: one conversation pipeline for the private chat and groups

Goal: Ted behaves the same in the owner's private chat and in groups. Owner-only tools (mail, calendar,
Notion, approvals, reading the owner's logs) stay owner-only, enforced in `src/policy.ts`. Everything else
(memory, context handling, web search, style, voice in/out, reactions, typing, read receipts, quote context,
error notices, dream, proactive actions) is ONE code path, not two kept in sync.

Ground rules
- Read `docs/ARCHITECTURE.md` and `docs/SAFETY.md` first. Match the code style (short comments that say why).
- One commit per step, pushed, with `npx tsc --noEmit --noUnusedLocals`, `npm test`, `npm run check:secrets`
  green. Then restart: `launchctl kickstart -k gui/$(id -u)/com.ben.ben-e` and `npm run doctor`.
- Update docs (README, ARCHITECTURE, SAFETY, SIGNAL-ACCOUNT, `.env.example`) in the step that changes behaviour.
- `git stash@{0}` holds an abandoned "routines" attempt: drop it (`git stash drop`), do not reuse it.

## Step 1: `src/conversation.ts`, the shared pipeline

Today `chat()`/`route()`/`hear()`/`reacted()` in `src/main.ts` and `createGroupBrain` in `src/group.ts` each do
record → run → parse `[[react]]`/`[[voice]]`/`[[silent]]` → speak/send/thread → typing → error notice. Merge them.

- A `Conversation` is plain data, made ONLY by two factories so trust cannot be mixed up:
  `owner()` and `group(groupId)`. Everything else derives from that choice: Signal target (peer chat or
  groupId), policy source (`chat` / `group`), notes folder, log file, session file, system prompt builder,
  whether the participation gate applies, whether approvals exist (owner only).
- Sending, reacting, speaking (TTS), typing, read receipts, quoting: same code for both, parameterised by
  the target. The Signal client already takes a groupId for send/typing; give `markRead` and `sendVoice` a
  target too.
- One `handleIncoming(conv, event)` for messages, voice messages (transcribe: shared), and reactions, and one
  `deliver(conv, reply, trigger)` for the reply. Errors become a notice in both (texts in `src/errors.ts`),
  rate-limited in groups.
- A per-conversation serial queue (the owner's chat already has one; groups currently can run twice at once).
  Approval answers stay a pre-queue step, owner only. The group gate's debounce/epoch logic stays, inside the queue. (Later: the settling pause and folding a burst into one turn moved into the shared pipeline, for the owner's chat too.)
- Move the pipeline out of `main.ts` so it is testable with a fake Signal client. Write those tests FIRST
  against today's private-chat behaviour, so the refactor is verified as no behaviour change for 1:1.
- Result: groups gain voice replies, quote context and read receipts for free.

## Step 2: SDK memory and session handling for groups too

2a. Prove isolation before switching (a test or script against the real SDK, cheap model):
- put a unique canary string in an owner note (`memory/notes/`), start a group-configured run with
  `settings.autoMemoryDirectory` = that group's notes folder and `settingSources: []`, ask it to list/recall
  everything it remembers and to Read the owner's notes path;
- pass only if the canary appears nowhere (output, tool results) and the Read is denied.
  If it fails, stop and report; keep the custom group tools.

2b. Switch groups to the SDK's built-in memory (same as the owner's chat in `src/agent.ts`):
- per-conversation `autoMemoryDirectory`; Read/Write/Edit allowed only inside that conversation's notes
  folder (path resolved, symlinks followed; generalise `isNotePath(path, dir)`).
- No write-time limits: no file-name pattern, size or note-count checks, no hook. Containment (`isInside`,
  `src/contain.ts`) is the only gate on writes, for the owner's notes folder and for groups alike. Bounds stay
  where they already are: how much of the notes a prompt includes (`MAX_NOTES_SHOWN`, `memoryRunChars`) and the
  nightly dream's caps/tidying. (2a passed: `npm run check:isolation`. Note the SDK auto-allows writes inside
  `autoMemoryDirectory` without calling canUseTool and resolves `..` first, so containment is `autoMemoryDirectory`
  plus `isInside` for every other file-tool path.)
- `forget_note`, `search_logs`, `undo_dream` become scope-aware tools from one server
  (`src/memory-tools.ts`): a group can only touch its own notes and search its own log.
- Remove `remember_note`/`forget_note`/`search_history` from `src/group.ts` and `saveGroupNote` etc. from
  `src/groupstore.ts` where unused. Memory-change announcements ("🧠 Memory … undo"): owner only; in groups
  the reply says what was saved.

2c. Context handling: groups use the owner's model (resumed SDK session, idle reset, compaction, warm
process) instead of "fresh run + last 25 log lines":
- generalise `state/session.json`, `chatResume`, `prepareChat`, `compactChatIfNeeded` (`src/agent.ts`,
  `src/session.ts`) to a per-conversation session file (e.g. the group's folder). Warm process: keep at most
  one for the owner plus one for the most recently active group (or none for groups) and say which in a comment.
- Group messages not addressed to Ted still go into the session as context (prompt them in, marked as
  "said in the group, no reply needed") or are prepended on the next turn: pick the cheaper and document it.

## Step 3: one gate for messages and time (the shared "heartbeat")

The group participation gate (`realGate` in `src/group.ts`) and a proactive wake-up are the same question:
"should I do something now?". Make it one shared gate in its own module.
- Triggers: a message or reaction (groups only: in the owner's chat and for tagged/quoted group messages a
  message is always answered, no gate), or the clock (every heartbeat tick, for every conversation whose
  "next look" time has come).
- Input: clock, the conversation's notes (incl. style), the tail of its log, its default rules (persona,
  tweakable by notes). Output (json_schema): `{ act, task, nextCheckMinutes }`.
- Ledger = the log: Ted's own posts are already logged; add log kinds `action` (did something without
  posting) and `wake` (the chosen next look). Filter both out of anything that reads the log as conversation
  (chat context, dream evidence, compaction summary, recent lines).
- Acting runs the conversation's normal runner with the task: groups with group tools, the owner with the
  radar's least privilege (`source` like `radar`; add a source if cleaner). It may answer `[[silent]]`.
- Code guards: pause, daily budget (use `budgetSpent()`, never `overBudget()` which consumes the owner notice),
  max actions per conversation per day, owner quiet hours, `nextCheckMinutes` clamped (15 to 60 while awake).
  Any new message or note change marks the conversation for a look on the next tick.
- This is what lets "every morning post a fun fact" or "nudge us Friday" work, in 1:1 and groups, with the
  instruction living in plain memory notes.

## Step 4: the daily brief and the radar become gate actions

Do this after step 3 is committed and has worked live for a day or two.

Today WHEN they run is hard-coded: the brief's time window and attempt rules (`shouldRun` in `src/brief.ts`,
triggered from the heartbeat's `onTick` in `src/main.ts`) and the radar's adaptive schedule
(`src/radar-rules.ts`: `isDue`, `scheduleNext`). Move the WHEN to the owner conversation's gate; keep the HOW
in code.
- One `Task` type for everything the gate can start: `{ name, instructions, profile, after, retries? }`.
  - `profile` = HOW a run is allowed to work, fixed in code: the policy source (which tools are allowed,
    asked, denied: `src/policy.ts`), system prompt, skills offered, max turns, max budget, output schema.
    Today these live in `runBriefTurn` / `runRadarTurn` / `runHandlerTurn` in `src/agent.ts`; turn them into
    named profiles.
  - `after` = what happens with the result: post the answer to the conversation (default), or a preset's own step.
  - Free-form `task`: instructions written by the gate, a least-privilege background profile, answer posted.
  - `brief` preset: instructions = the daily-brief skill, brief profile, after = capture the sent email, post
    the Signal summary, save `memory/last-brief.md`; retries = up to `briefMaxAttempts` a day if incomplete.
  - `radar` preset: instructions = the radar skill, radar profile, after = post its messages. Its dedupe keys
    in state go away: like every task it sees the conversation log (the ledger) and must not repeat what is
    there; its message-rate rules become the generic cap on posts per conversation per day.
  - Presets are owner-only; groups only get free-form `task` (with the group profile).
- The gate's output: `{ act, task: "task" | "brief" | "radar", instructions?, nextCheckMinutes }`.
- Default rules in the gate's prompt (persona), tweakable by notes ("brief at 6:30", "no radar on weekends"):
  brief once a day in the morning; radar shortly before meetings and every few hours while awake.
  The log shows when each last ran (the brief already logs kind `brief`; log task runs as `action`).
- Deterministic backstop for the brief: if no brief is logged by `settings` time (default 09:00) on a day,
  run it anyway. The dream keeps running before the brief (today `dreamer.run()` precedes it).
- Tests: the gate choosing `brief`/`radar` runs the right preset with the right profile; retries; the backstop; groups can never get them.
- Docs: README "a day with Ted", ARCHITECTURE (heartbeat section), `.env.example` (brief/radar timing settings
  that are now defaults in the gate prompt: remove or mark as backstop).
