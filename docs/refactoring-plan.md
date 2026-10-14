# Refactoring plan

Goal: smaller, cleaner code with **no behaviour change**. Prompts, policy rules, timeouts, defaults, log formats,
the safety model and memory isolation stay exactly as they are. Baseline before any change: `tsc --noEmit
--noUnusedLocals` clean, 312 tests passing, `check:secrets` clean.

Line counts before (non-blank, as `wc -l`):

| File | Lines |
|---|---|
| packages/signal/src/client.ts | 529 |
| src/agent.ts | 500 |
| src/conversation.ts | 450 |
| src/dream.ts | 371 |
| src/heartbeat.ts | 297 |
| src/gate.ts | 264 |
| src/persona.ts | 232 |
| src/cli.ts | 215 |
| src/messages.ts | 189 |

## How "behaviour-preserving" is proved

1. Pure moves (a function or constant goes to another file with the same body): `tsc` fails if a name or import is
   wrong, and the existing 312 tests plus `check:isolation` run unchanged. Tests are edited only where they import a
   moved name (path only).
2. Dedupes that touch logic: a characterization test is added first (it passes on the old code), then the refactor
   must keep it green.
3. Every commit: `npx tsc --noEmit --noUnusedLocals`, `npm test`, `npm run check:secrets` all green.
4. Dead code is only removed with evidence: `tsc --noUnusedLocals` (locals), and a name-by-name search across
   `src/`, `test/`, `scripts/` and `packages/` for exports (export-with-no-importer script, then `tsc` again after
   removing `export`, which reveals anything that was only exported).

## Opportunities, ranked by value and risk

### 1. Split agent.ts (value high, risk low) - DO NOW
`src/agent.ts` mixes six jobs: run profiles, the permission callback, the tools-seen list, note-change
announcements, session resume/compaction, and the warm-process slots. Split into cohesive modules, no body changes:
- `profiles.ts`: `ProfileName`, `OwnerProfile`, `RunProfile`, `PROFILES`, `OFFERED_SKILLS`. tasks.ts and wake.ts
  only needed these types, so they stop depending on the SDK-running module.
- `permissions.ts`: the `canUseTool` callback, `idsOf`, `setDraftReader`, `setAutoApprovedNotice`, the owner-message
  value the judge reads.
- `toolsseen.ts`: the seeded list of tool names and its read/record.
- `memorynotice.ts`: the per-turn list of note changes and the "reply with no words" notice rule
  (`needsMemoryNotice`).
- `chatsession.ts`: `chatResume`, the plan options, `/compact` (`compactOptions`, `compactChatIfNeeded`).
- `agent.ts` keeps `buildOptions`, `consume`, the run entry points and the warm slots.
Proof: pure moves; imports updated everywhere (no re-export layer); tests change import paths only.

### 2. One warm-or-cold run path in agent.ts (value medium, risk low) - DO NOW
`ask()` (owner) and `runGroupTurn()` (group) both: take the warm process if its key still matches, log a different
prefix on failure, otherwise start a cold `query`, then `consume`. `prepareChat` and `prepareGroupChat` both start a
warm process, log on failure and put it in a slot. Extract `runTurn`-style helpers that take the slot, key and log
label as data. The log prefixes ("chat:", "group:") stay exactly as they are.
Proof: `test/warmslot.test.ts` and `test/group.test.ts` cover the group path with a fake `query`/`startup`; the
owner path now goes through the same function with different data.

### 3. Owner and group divergence (value medium)
Shared already: pipeline, queue, burst, typing, deliver, notice. What still diverges, and the decision:
- `hear`/`see`: "tell the sender why, owner always, group only if addressed" is written twice - extract one
  `tell(conv, m, text)` helper. DO NOW (tested by conversation.test.ts).
- `main.ts`: `isOwnerAccount` and `fromOwner` are the same predicate over two shapes, the `vouch` lambda is written
  twice (pipeline and wake-ups), `prepareChat(approve, say)` five times. DO NOW (one predicate, one `vouch`, one
  `warmChat`).
- `wake.ts`: the `res.error ? "failed" : res.spoke ? "posted" : "silent"` line twice. DO NOW.
- `session.json` path: the literal `"state/session.json"` is in agent.ts and in the owner Conversation. DO NOW: one
  constant in session.ts.
- `ownerMessage` vs `groupMessage` intake (vouch first, read receipt only if addressed, transcript prefix, picture
  only when it will be used, order of recording vs. approval check) and the log wording in `runTurn`
  (`agent replied`/`group replied`, `agent failed:`/`group: run failed:`): these differ in observable behaviour or
  log text. LEAVE; proposal: model the intake differences as flags on the Conversation (`receiptsFor`,
  `transcriptPrefix`) and give the log line one `label` field, accepting that two log strings change.
- Two scheduling paths in `main.ts` (`SCHEDULER=legacy` vs gate): behaviour switch, LEAVE (owner decision whether to
  retire legacy mode).

### 4. Split dream.ts (value medium, risk low) - DO NOW
371 lines: the pure planner (`Op`, `Plan`, `planOps`, `noteContent`, `Scope`, `OWNER_SCOPE`), the file-touching part
(`snapshot`, `upsertIndex`, `applyPlan`, `undoLatest`), prompts + the model runner, and the daily run. Split into
`dreamplan.ts` (pure), `dreamapply.ts` (snapshots/apply/undo) and `dream.ts` (prompts, runner, the daily dreamer).
`dreamapply.ts` does not reach agent.ts, so `memory-tools.ts` no longer needs the lazy `import("./dream.ts")`; it
imports `undoLatest` statically. Proof: dream.test.ts and group.test.ts (planOps, applyPlan, undoLatest, the group
dreamer) unchanged except import paths.

### 5. Split gate.ts (value medium, risk low) - DO NOW
The ledger half (`ledger`, `LookState`, `lookState`, `lookDue`, `Wake`, `parseWake`, `wakeText`, `recordWake`,
`notesChangedAt`, `KEY_TTL_MS`) is about 90 lines of pure code that tasks.ts, radar-nudge.ts and wake.ts use. Move to
`ledger.ts`; `gate.ts` keeps the schema, parsing, prompts and `askGate`. `tailLine` stays in gate.ts and imports
`parseWake`. Proof: gate.test.ts, tasks.test.ts (import paths only).

### 6. Split cli.ts (value low-medium, risk low) - DO NOW
`doctor()` is 100 lines of checks. Move it and the local-time helper into `doctor.ts`; cli.ts is the dispatcher with
report/restore. The `npm run` commands still point at `src/cli.ts`. Proof: `node ... cli.ts` with no argument prints
the usage line before and after; `doctor.ts` is a pure move.

### 7. Split packages/signal/src/client.ts (value medium, risk low) - DO NOW
The first ~245 lines are pure types and parsing (`interpretEnvelope`, `parseAudio`, `parseImage`, `parseQuote`,
`withMentions`, `attachmentPath`, ...). Move to `envelope.ts`; `client.ts` is the connection only. `index.ts` keeps
the same public exports. Proof: package tests (envelope, client, voice) import path only; `npm run verify-pack -w
packages/signal` checks the published surface.

### 8. heartbeat.ts duplicate (value low, risk nil) - DO NOW
`NewMail` is built from an inbox row in `checkMail` and again in `triageCheck`; extract `newMail(inbox, row)`.

### 9. Dead code
- `tsc --noUnusedLocals`: nothing unused at baseline.
- Exports with no importer anywhere (src, test, scripts, packages): about 60 (types and constants only used in their
  own file). DO NOW: drop `export` where there is no importer, then let `tsc --noUnusedLocals` show whether anything
  is then unused and delete only that. No whole function was found dead in the sweep.
- `AuthError, RateLimitError` re-export in agent.ts: importers switch to `errors.ts`. DO NOW.

### 10. Left for the owner (would change behaviour or touches the do-not-touch list)
- `src/policy.ts`, `src/contain.ts`, approvals and memory isolation: untouched. Observation only: `policy.ts` source
  names are a string union in `audit.ts` and a key set in policy.ts; one table would remove a drift risk but is a
  policy-file change.
- `persona.ts` (232 lines) is prompt text; any edit is a prompt change. Untouched.
- `messages.ts` (189): cohesive (log, cache, compaction), nothing to remove.
- `runTurn` log strings and the two intake paths (see 3).
- Retiring `SCHEDULER=legacy` (brief.ts/radar.ts timers) would remove roughly 100 lines and two code paths.
- Retry/timeout constants spread across files (`STICKY_MS`, `BRIEF_RETRY_GAP_MINUTES`, `SPARE_MAX_AGE_MS`...) could
  live in settings.ts, which changes how they are configured: proposal only.

## Result (after implementation)

| File | Before | After |
|---|---|---|
| src/agent.ts | 500 | 278 |
| packages/signal/src/client.ts | 529 | 310 (+ envelope.ts 226) |
| src/dream.ts | 371 | 198 (+ dreamplan.ts 131, dreamapply.ts 59) |
| src/gate.ts | 264 | 163 (+ ledger.ts 112) |
| src/cli.ts | 215 | 88 (+ doctor.ts 124) |
| src/conversation.ts | 450 | 453 (a new `tell()` helper replaced two copies; one import) |
| src/heartbeat.ts | 297 | 299 |
| src/persona.ts, src/messages.ts | 232, 189 | unchanged |

Tests: 312 before, 315 after (3 new characterization tests: note-change notice x2, group voice/picture failure).
Done: items 1 to 9. Not done on purpose: item 3 (intake and log wording) and everything in item 10.
Not found: a dead function. `tsc --noUnusedLocals` was clean throughout, and after narrowing 62 unneeded exports it
was still clean, so nothing became unused.
`npm run check:isolation` calls a live model; it failed once on the first run after the dream split and passed on
the immediate rerun and at baseline-equivalent code paths, so treat a single failure there as model noise and rerun.
