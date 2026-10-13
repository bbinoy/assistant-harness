# Review: `packages/signal` as a standalone package

Reviewed against origin/main at a28ae0b (includes the image support in `client.ts` and the TTS provider/tuning in `tts*.ts`). Review only; no code was changed. Effort: S = under an hour, M = a few hours, L = a day or more.

## Verdict

The package is closer to standalone than most: no imports from `src/`, no dependencies, 17 tests that run with `npm test` inside the folder, an MIT licence, and a README that already exists (so no draft was added). What blocks publication is mostly packaging (it ships `.ts` source and has no build), a few process-level behaviours that are wrong for a library (`process.exit` in `client.ts` and `daemon.ts`, `console.*` logging), hard-coded macOS paths, a mixed-in speech/transcription surface, and no tests for `SignalClient` itself.

## Findings, ranked

### P1. Library code kills the host process
- Files: `src/client.ts:269-275` (socket `close` calls `process.exit(1)`), `src/daemon.ts:23-26, 29-31` (child exit calls `process.exit(1)`; registers `process.once` handlers for `exit`, `SIGTERM`, `SIGINT` and calls `process.exit(0)`).
- Problem: a consumer cannot reconnect, shut down cleanly, or run two clients. The comments say "launchd restarts us", which is an app policy.
- Fix: `SignalClient` becomes an `EventEmitter`-style object (or takes `onClose`) that emits `close`/`error`; the app's `main.ts` decides to exit. `ensureSignalDaemon` returns a handle `{ stop(), exited: Promise<{code,signal}> }` and installs no signal handlers; the app wires those. Keep the exit-on-death behaviour in `src/main.ts`. This is a breaking change, so do it before 1.0.
- Effort: M.

### P1. Source-only package: no build, `exports` points at `.ts`
- File: `packages/signal/package.json` (`"exports": { ".": "./src/index.ts" }`, `files: ["src", "scripts", "README.md"]`, no `types`, no `build`, no `prepack`).
- Problem: Node only strips types from `.ts` outside `node_modules`; type stripping is refused for files under `node_modules`, so the published package would fail to import. Consumers also cannot get `.d.ts`. The root `tsconfig.json` is `noEmit` and covers the package by glob; the package has no tsconfig of its own.
- Fix: add `packages/signal/tsconfig.build.json` (extends root, `noEmit: false`, `outDir: dist`, `declaration: true`, `rewriteRelativeImportExtensions: true`, `include: ["src"]`), a `build` script, and `prepack: npm run build`. Set `exports` to `{ ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`, `files: ["dist", "scripts", "README.md", "LICENSE"]`. For the monorepo keep working from source with a `"development"`/custom condition, or let the app import `dist` after a build step in the root scripts. Remove `private`-style ambiguity: the package has no `"private"` and a placeholder scope, so decide the real name first (`@ted-personal-assistant/...` is the app's name; a neutral name such as `signal-cli-rpc` would age better).
- Effort: M.

### P1. Hard-coded macOS/Homebrew paths and Python layout
- Files: `src/tts.ts:15,19-20` and `src/transcribe.ts:12`, `src/tts-remote.ts:13` (`EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin"`, duplicated three times); `src/tts.ts:14` (script located relative to `import.meta.url`: breaks once bundled or moved to `dist`); `src/tts.ts` `files()` assumes `venv/bin/python` (not Windows); `src/transcribe.ts` hint text "brew install whisper-cpp"; the app's settings default `~/.cache/ted-personal-assistant/...` (outside the package, `src/settings.ts:61,150`).
- Fix: one `src/internal/exec.ts` with a single `toolEnv(extraPath?)`; make it an option (`binDirs?: string[]`) instead of a constant, default to the plain `PATH`. Resolve `kokoro-say.py` via a documented option (`scriptPath`) with the packaged copy as default and keep `scripts/` in `files`. Make binary names options (`ffmpegPath`, `whisperCli`, `python`). State "macOS/Linux, Windows untested" in the README.
- Effort: M.

### P2. Public API is too wide and mixes three concerns
- File: `src/index.ts` exports client, daemon, Kokoro TTS, remote-TTS internals (`isSafeUrl`, `sniffAudio`, `ELEVENLABS_BASE`), and transcription in one barrel. `isSafeUrl` is exported only because `src/settings.ts:3` validates a URL with it; `MAX_AUDIO_BYTES` is defined twice with different meaning (`client.ts:38`, `tts-remote.ts:15`; only the first is exported).
- Proposal (semver-minded):
  - Root `.` (stable core): `SignalClient`, `ensureSignalDaemon`, types `IncomingMessage`, `IncomingReaction`, `Quote`, `AudioRef`, `ImageRef`, `Channel`, plus pure helpers `interpretEnvelope`, `parseQuote`, `withMentions`, `parseAudio`, `parseImage`, constants `MAX_AUDIO_BYTES`, `MAX_IMAGE_BYTES`. Mark `parse*` and `withMentions` as `@internal`-ish or move under `./testing`/`./parse` unless a consumer needs them; fewer exports means fewer majors.
  - `./voice` entry point (optional): `transcribe`, `voiceReady`, `cleanTranscript` (whisper.cpp + ffmpeg).
  - `./tts` entry point (optional): `synthesize`, `ttsReady`, `synthesizeWith`, `providerReady`, config types, `MAX_SPOKEN_CHARS`.
  - Not exported: `sniffAudio`, `ELEVENLABS_BASE`, `synthesizeRemote`, `describe`. Export `isSafeUrl` only if the app keeps needing it (or move that validation into the config schema of the `./tts` entry).
- Separate package or entry point? Start with subpath entries in one package (cheap, one release). Split into `…-voice` later only if the speech code grows, since it shares nothing with the client at runtime and has different external requirements (ffmpeg, Python, whisper-cpp, HTTPS to third parties). Core must never import from the voice entries. Add an `exports` test (import each entry, snapshot the key list) so an accidental API change is visible.
- Naming for 1.0: `SignalClient` constructor's positional `(host, port, account, peer?)` is awkward and the "mode" is implied by an optional fourth argument; prefer `new SignalClient({ host, port, account, peer? })`. `send(text, textStyle, quote, opts)` should become `send(text, opts)`; return type could carry `{ timestamp }`. `separateAccount` could be `mode: "note-to-self" | "peer"`. `voice?: boolean` on `IncomingMessage` is set by the app, not the package (`client.ts:28`): remove it or document it as app-owned. Do all of these before 1.0; document `0.x` as unstable.
- Effort: M.

### P2. `SignalClient` internals are not library-grade
- File: `src/client.ts`.
  - `console.error` in six places (`markRead`, `onLine`, `react`, socket close, ...): take an optional `logger` (`{ warn, error }`), default no-op or `console`.
  - Hard-coded 30 s RPC timeout (`:320`), 5 min own-reaction memory (`:334`): options.
  - `connect()` has no reconnect, no `close()` method, no `error` handling after connect (the `once("error", reject)` handler is gone after connect, so a later socket error is an unhandled `error` event that throws). Add `close()`, `onClose`, and a post-connect error listener.
  - `call()` uses `this.socket!` and throws a `TypeError` if called before `connect()`; throw a clear error.
  - A single handler slot (`onMessage` replaces the previous one): either document it or return an unsubscribe / allow multiple.
  - `any` throughout the wire parsing (`interpretEnvelope(env: any, ...)`): add minimal wire types so consumers and tests see the shape.
  - Image/audio refs only carry an `id`; resolving it to a file needs signal-cli's attachments directory, which today lives only in the app (`src/settings.ts:165`, `signalAttachmentsDir`). Add `attachmentPath(ref, dir?)` to the package (the traversal-safe id check is already here), so consumers do not re-implement it.
- Effort: M.

### P2. Tests do not cover `SignalClient`; no fake signal-cli
- Files: `test/envelope.test.ts` (pure parsing, good), `test/voice.test.ts`, `test/tts-remote.test.ts` (uses a fake `fetch` and a real `ffmpeg`, see below).
- Gaps: no test for the JSON-RPC framing (partial lines, multiple lines per chunk, unparseable line), request/response correlation, timeouts, `send` parameters per mode (`noteToSelf` vs `recipient` vs `groupId`, quote fields, style, attachments), `react`/`isOwnReaction`, `markRead`, `typing`, `groups()` mapping, `ensureSignalDaemon` (port already open path). The app has `test/conversation.test.ts` with a fake client, but that fake is private to the app.
- Fix: add `src/testing.ts` (exported as `./testing`): `FakeSignalDaemon`, a tiny `net.Server` on port 0 that speaks line-delimited JSON-RPC, records requests, lets a test push `receive` notifications and script responses. Use it for `SignalClient` tests and ship it so consumers can test their bots. Also `createFakeSignalClient()` implementing the same surface for unit tests that do not want a socket. Separately: the `tts-remote` tests need `ffmpeg` on the machine (`execFileSync` in the test); skip with a clear message when absent so the package passes on a bare CI runner. Add a package-level CI job (`npm test -w packages/signal` on Node 24, no ffmpeg) and `tsc` with the package's own tsconfig to prove it compiles alone.
- Effort: M.

### P2. Documentation gaps
- Existing: `README.md` covers modes, quick start, API list, groups, voice, files. Good start.
- Missing:
  - Install section (npm name, Node 24, how to install signal-cli, Java requirement, registering/linking an account: currently links to the app's `../../docs/SIGNAL-ACCOUNT.md`, which will not exist in a published package; inline a short version or link by absolute URL).
  - How to run the daemon yourself versus `ensureSignalDaemon` (and what that function does to your process, until P1 is fixed), the `--tcp`/socket choice, and that JSON-RPC is over TCP only (no stdio / unix socket support). State the tested signal-cli version range; the field names used (`sourceNumber`, `destinationNumber`, `targetSentTimestamp`, `groupInfo`, `textStyle` strings) follow signal-cli's current JSON-RPC and have shifted between versions.
  - Attachments: how ids map to files in signal-cli's `attachments` folder, size limits (25 MB audio, 20 MB image), that only the first audio and first image are surfaced, and that sending files needs absolute paths readable by signal-cli.
  - Text styles format, mention handling, `@name` rendering, reactions semantics (note the "status indicator" use), quote semantics, peer mode with `aci`.
  - JSDoc: the comments are good prose but are line comments (`//`), not `/** */`, so editors and TypeDoc do not show them. Convert the public symbols (constructor, each method, each exported type field, each `*Config`), add `@param`/`@returns`/`@throws`, and mention which methods are best-effort and never throw (`react`, `markRead`, `typing`) and which can reject (`send`, `groups`, `connect`).
  - Runnable examples: add `packages/signal/examples/echo.ts` (Note to Self echo), `examples/peer-bot.ts` (own account, groups, reaction), `examples/voice-reply.ts`; make them compile in `tsc`. The app's `scripts/signal-hello.ts` is a starting point but depends on the app's `.env`.
  - Changelog, `SECURITY.md`/security section (below), contribution notes, supported-platform note.
  - Comments that name the app: `client.ts:27,29` ("main.ts transcribes it"), `client.ts:50` ("src/image.ts"), `tts-remote.ts:9`, `tts-elevenlabs.ts:3` ("Ted"), `tts-http.ts:3,4` ("docs/REMOTE-TTS.md" lives in the app), `tts.ts:9-10` ("`scripts/setup-tts.sh` in the app"), `daemon.ts` ("launchd"). Reword or make the referenced docs part of the package (copy `REMOTE-TTS.md` and the setup script into `packages/signal/docs` and `scripts`).
- Effort: M (README additions S, JSDoc M, examples S).

### P2. What the library trusts (security notes to write)
- State plainly in the README:
  - signal-cli's TCP socket is unauthenticated; whoever can connect can send as the account. `ensureSignalDaemon` has no check that `host` is loopback: add a guard (throw unless `127.0.0.1`/`::1`/`localhost`, with an explicit override) and document it.
  - The client trusts every `receive` notification from the socket and does not authenticate senders. `direct` and `from` are derived from signal-cli's envelope; in Note to Self mode a message counts as the owner's because it is a sync from the owner's other device; in peer mode `from` equals the peer only if number (or aci) matches. **Authorisation is the application's job** (the README already says so; keep it prominent).
  - Attachment ids are validated against `^[\w.-]{1,100}$` and not starting with `.`; the id is still only a file name inside a folder the caller chooses; the caller must `join` it with that folder and must not follow symlinks outside. Content type is taken from the sender's claim; the bytes are not checked (the app does so in `src/image.ts`).
  - Message text, quotes, names (`fromName`) are untrusted user input; do not put them into prompts or shell commands unfenced.
  - Voice: `transcribe` and `synthesize` run `ffmpeg`, `whisper-cli` and Python via `execFile` (no shell) with fixed arguments; the file path/model/text come from the caller. Text goes to the Python script on stdin. Remote TTS sends the spoken text to a third party (ElevenLabs or your server); keys come from the caller and are redacted in error messages; redirects are refused; response size is capped (25 MiB) and the format is sniffed; https is required except for loopback (`isSafeUrl`).
  - Temp folders under `os.tmpdir()` (`speech-*`, `voice-*`) are created `0700` by `mkdtemp`; `synthesize*` returns a path inside one and the **caller must delete it** (document, or return `{ path, cleanup() }`).
- Effort: S.

### P3. Licensing and third-party notices
- Package licence: MIT (`package.json`); the repo `LICENSE` says "Copyright (c) 2026 Ben". Copy `LICENSE` into `packages/signal/` (npm includes it automatically only from the package folder) and decide the copyright holder line (a personal name is fine if intended; this is the owner's call).
- **signal-cli is GPL-3.0.** This package does not include, link or bundle signal-cli: it starts it as a separate process (`spawn("signal-cli", ...)`) and talks to it over a TCP socket with JSON-RPC. In general, communicating with a GPL program across a process/socket boundary is treated as using it, not as creating a combined work, so the GPL does not apply to this package's own code, and MIT stays possible. What follows from that for the README (this is not legal advice; the owner may want to confirm): say that signal-cli is a separate program, licensed GPL-3.0, that it is **not** bundled or redistributed, that users install it themselves under its own licence, and link to its repository; do not vendor a signal-cli binary or its jars in the npm tarball or in any container image/example without complying with the GPL for those parts. The same "separate program, not bundled" statement applies to whisper.cpp (MIT), ffmpeg (LGPL/GPL depending on build), Kokoro model and `kokoro-onnx` (check the model/voice licence terms before suggesting commercial use), and the optional ElevenLabs service (their terms apply; voice-cloning needs rights to the voice). Put a short "Third-party software" table in the README. Also note that this is an unofficial integration not affiliated with Signal.
- Effort: S.

### P3. Publication hygiene scan
- Searched `packages/signal` for real phone numbers, emails, home paths, tokens and personal names: none found. Test numbers are fictional (`+10000000000`, `+10000000001`, `+15555550105`; the 555 range is the reserved fiction range), the sample name is "Eve". `npm run check:secrets` is the gate (run during this task; see below).
- To scrub or decide before publishing: "Ted"/app references in comments (see docs findings); `/opt/homebrew` paths (P1); the placeholder scope `@ted-personal-assistant` and "Not yet published; name and scope are placeholders" (README last line); the `LICENSE` holder name; git history of the repo (publishing the package from a subfolder via `npm publish` ships only the tarball, not history, but if the owner later splits the repo with history, run the secrets scanner over history as well, as an earlier commit may contain things the working tree no longer has).
- Check the tarball before each release: `npm pack --dry-run` to see exactly which files ship (today `scripts/kokoro-say.py` and `src`; the tests are excluded by `files`, which is right).
- Effort: S.

### P3. Minor
- `package.json` lacks `repository`, `homepage`, `bugs`, `author`, `sideEffects: false`, `publishConfig.access: "public"` (needed for a scoped package). No `peerDependencies` are needed (no dependencies); document external binaries as "system requirements" (README) rather than `peerDependencies`. `engines.node >=24` is justified by running TS directly today; after a build step the real minimum is lower (global `fetch` and `AbortSignal.timeout` need 18+/20+): choose deliberately.
- `Fetch` type is exported from `tts-remote.ts` but not from the index; fine unless it becomes part of the config types (it already is, via `fetchImpl` in `ElevenLabsConfig`/`HttpTtsConfig`, which `TtsProviderConfig` references: so these config types leak non-exported names. Export the config types from the voice entry.)
- `kokoro-say.py` language is chosen as `en-gb` for voices starting with `b`, otherwise `en-us`: English only. Document.
- `transcribe` uses `-l auto` and temp directory per call; fine. No concurrency limit: document.
- Consumed today by the app as an npm **workspace** (`"workspaces": ["packages/*"]`, dependency `"@ted-personal-assistant/signal": "*"`, symlinked in `node_modules`); the app imports only from the package root. The root `npm test` also runs `packages/*/test/*.test.ts`. App-owned things the package should not know about: `docs/ADAPTING.md:99-100` points at package files as the replaceable contract; keep that doc in sync after any rename.

## Couplings to the app (complete list)

| Coupling | Where | Cut |
|---|---|---|
| No `import` from `src/` anywhere | whole package | none needed (verified) |
| Process exit on socket close | `client.ts:273` | emit `close`; app exits |
| Process exit and signal handlers | `daemon.ts:23-31` | return handle; app wires |
| `console.log/error` | `client.ts` (5), `daemon.ts` (3), `tts-provider.ts` (1) | injected `logger` |
| Homebrew `EXTRA_PATH` | `tts.ts`, `transcribe.ts`, `tts-remote.ts` | option `binDirs`, one helper |
| Script path relative to module | `tts.ts:14` | option `scriptPath`, packaged default |
| App settings/env names in comments (`TTS_*`, `TTS_FALLBACK`, `.env`) | `tts-elevenlabs.ts`, `tts-http.ts`, `tts-provider.ts`, `tts-remote.ts` | reword; the package takes plain config objects (it already does; no env var is read in the package) |
| Settings → config mapping | `src/settings.ts` builds `TtsProviderConfig` | stays in the app (correct direction) |
| Attachment folder resolution | `src/settings.ts:165` (`signalAttachmentsDir`) | add `attachmentPath` helper in package |
| `voice?: boolean`, `main.ts`/`src/image.ts` comments | `client.ts:27-29,50` | remove or document |
| Docs outside the package | README links `../../docs/SIGNAL-ACCOUNT.md`; `tts-http.ts` points at `docs/REMOTE-TTS.md`; `tts.ts` at `scripts/setup-tts.sh` | move or copy into package |
| Env vars | none read in package (`process.env.PATH` only) | ok |
| Repo layout | `import.meta.url`-relative script only | see above |

## Migration plan (small commits, in order)

Each step keeps `npm test` and `npm run typecheck` green at the repo root. Another agent can take them one at a time.

1. **(S) Characterise.** Add the missing `SignalClient` tests against a throw-away in-test `net.Server` (framing, correlation, send params per mode, groups mapping). Commit: "signal: test SignalClient against a fake JSON-RPC server". This protects every later step.
2. **(S) Extract the fake.** Move that server to `src/testing.ts` with `FakeSignalDaemon`; add `./testing` to the planned exports. Skip ffmpeg-dependent tests when `ffmpeg` is absent.
3. **(S) Dedupe small things.** One `toolEnv()` helper replacing three `EXTRA_PATH` copies; rename the second `MAX_AUDIO_BYTES`; no behaviour change.
4. **(M) Logger injection.** Optional `logger` on `SignalClient`, `ensureSignalDaemon`, `synthesizeWith`; the app passes its `log`.
5. **(M) Lifecycle without `process.exit`.** `onClose`/`close()` on the client, handle return from `ensureSignalDaemon`, post-connect socket error listener; `src/main.ts` keeps the exit-and-let-launchd-restart policy. Add tests with the fake daemon (socket closes mid-request, rejects pending).
6. **(S) Loopback guard** in `ensureSignalDaemon`, with tests.
7. **(M) API cleanup for 0.2:** options-object constructor and `send(text, opts)`, remove `voice?`, `attachmentPath` helper; update the app call sites (grep list in `src/main.ts`, `outbound.ts`, `conversation.ts`, `scripts/*.ts`, `test/conversation.test.ts`, `docs/ADAPTING.md`).
8. **(M) Entry points:** `./voice`, `./tts`, `./testing` in `exports`; trim `index.ts`; add an exports test; the app imports from the subpaths (`settings.ts` for `isSafeUrl` and the TTS types, `cli.ts`, `main.ts`).
9. **(M) Build and metadata:** package `tsconfig.build.json`, `dist` output, `exports`/`types`/`files`, `LICENSE`, `repository` etc., `npm pack --dry-run` check, `prepack`. Verify by installing the packed tarball into a scratch folder and running an example under plain Node.
10. **(M) Docs:** README sections (install, signal-cli prerequisites, tested versions, security notes, third-party licences incl. GPLv3 explanation, attachments), `/** */` JSDoc on all public symbols, `examples/` compiled by `tsc`, `CHANGELOG.md`. Reword app-specific comments. Copy `SIGNAL-ACCOUNT.md` and `REMOTE-TTS.md` essentials into the package docs.
11. **(S) CI:** a job that runs the package's tests and build alone (`npm ci -w packages/signal`, no app files), plus `check:secrets` on the tarball contents.
12. **(S) Decide the name and scope**, replace placeholders, publish `0.x` with a `next` tag first.

Total: roughly 2-3 days of focused work; steps 1, 5, 8, 9 are the risky ones.

## Top priorities if only three things get done
1. Remove `process.exit` from library code (P1, step 5).
2. Make it installable: build output and real `exports` (P1, step 9).
3. Test `SignalClient` and ship a fake daemon (P2, steps 1-2).
