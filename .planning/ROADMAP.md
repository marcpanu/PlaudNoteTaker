# Roadmap: PlaudNoteTaker — Electron Menubar App + Obsidian Plugin

## Overview

This milestone wraps the existing PlaudNoteTaker CLI pipeline in a macOS menubar app and pairs it with an Obsidian plugin that provides a one-click speaker-labeling button. The roadmap moves from shared-code refactoring (so the CLI keeps working) through a signed+notarized Electron shell with the Eagle smoke test passed, into a working headless daemon with migration/config/Keychain/poll loop/logs/Settings, then user-facing surface (popover + notifications + HTTP bridge), and finally the Obsidian plugin that talks to that bridge.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Shared Seams** — Refactor `src/config`, `src/log`, `src/state` with injection seams so CLI and future app can share code without divergence
- [ ] **Phase 2: Electron Shell — Signed, Notarized, Eagle-Verified** — Boot a signed+notarized `.app` with menubar icon, no Dock, that proves Eagle native module runs in Electron's main process
- [ ] **Phase 3: Core Daemon — Migration, Config, Poll Loop, Settings, Logs** — App performs the full pipeline in the background with Keychain-stored keys, migrated state, live logs, and a configurable Settings window
- [ ] **Phase 4: User Surface — Popover, Notifications, HTTP Bridge** — App feels like a native menubar tool (popover, notifications, status icon states) and exposes a loopback HTTP bridge for Obsidian
- [ ] **Phase 5: Obsidian Plugin — Match Speakers Button** — Notes containing an Unknown Speakers callout render a one-click button that drives the daemon's label-and-enroll flow

## Phase Details

### Phase 1: Shared Seams

**Goal**: Three injection seams (config loader split, log pub/sub, dataDir parameter) exist in `src/` so the CLI and future Electron app can share 100% of pipeline code without divergence. CLI continues to behave identically.

**Depends on**: Nothing (first phase)

**Requirements**: SHAR-01, SHAR-02, SHAR-03, SHAR-04

**Success Criteria** (what must be TRUE):
  1. Running `npx tsx src/index.ts start`, `init`, `label`, `speakers`, and `test` in a terminal behaves identically to the pre-refactor CLI (no regressions in output, exit codes, or side effects).
  2. `src/state.ts` accepts a `dataDir` argument at every entry point — no module internally reads `config.dataDir` to resolve file paths.
  3. `src/config/` exports a single `Config` type produced by two source-specific loaders (env-based for CLI, app-source stub for the future app), with shared validation.
  4. `src/log/` exposes a subscribe/emit pub-sub interface with a console sink attached by default; existing `log()`/`warn()`/`error()` call sites continue to work unchanged.

**Plans**: 1 plan (single refactor sweep; small, mechanical, verifiable by CLI regression test)

Plans:
- [x] 01-01: Refactor `src/config` + `src/log` + `src/state` to introduce injection seams; verify CLI regression

---

### Phase 2: Electron Shell — Signed, Notarized, Eagle-Verified

**Goal**: A notarized `PlaudNoteTaker.app` installs to `/Applications`, launches as a menubar-only app (no Dock icon), passes Gatekeeper without right-click-Open, survives single-instance enforcement, quits cleanly via Cmd-Q, and — critically — successfully constructs and releases an `EagleProfiler` instance in the Electron main process (proving the Node native module works at Electron's ABI).

**Depends on**: Phase 1

**Requirements**: SCAF-01, SCAF-02, SCAF-03, SCAF-04, SCAF-05, MBAR-01, MBAR-02, MBAR-06, MBAR-07

**Success Criteria** (what must be TRUE):
  1. User double-clicks the produced DMG, drags `PlaudNoteTaker.app` to `/Applications`, launches it, and macOS Gatekeeper admits it without a right-click-Open or "unidentified developer" dialog.
  2. On launch, a template menubar icon appears in the system menu bar, no Dock icon ever appears, and launching the app a second time focuses/no-ops instead of spawning a parallel instance.
  3. On first launch, an Eagle smoke test constructs an `EagleProfiler` instance using the configured Picovoice key, logs `eagle.version`, and releases it — the app does not crash with `NODE_MODULE_VERSION` ABI mismatch.
  4. User can quit the app via Cmd-Q or a right-click → Quit menu item, and the process exits cleanly (no orphaned helpers, menubar icon disappears).
  5. The bundled `ffmpeg` binary exists at `Contents/Resources/bin/ffmpeg`, is individually code-signed with hardened runtime, and can be invoked by the main process (verified by running `ffmpeg -version` from within the packaged app).

**Plans**: 2 plans

Plans:
- [ ] 02-01: Electron Forge + Vite scaffold, `@electron/rebuild` postinstall, hardened-runtime entitlements, signing + notarization pipeline, LSUIElement, single-instance lock, Cmd-Q quit, template menubar icon
- [ ] 02-02: Eagle smoke test + ffmpeg bundling & afterSign codesigning (empirical gate — if Eagle fails in Electron 41, fall back to Electron 40 before any further phase work)

---

### Phase 3: Core Daemon — Migration, Config, Poll Loop, Settings, Logs

**Goal**: The installed app behaves as a self-contained daemon: on first launch it migrates the existing `.env` and `./data/` into Keychain + `~/Library/Application Support/PlaudNoteTaker/` atomically; it loads config from Keychain + `settings.json`; it runs the existing pipeline on a self-rescheduling poll loop that survives sleep/wake; it exposes live logs and a fully functional Settings window (API keys with test-connection, vault/templates pickers, poll interval, Gemini model, speaker profile management, launch-at-login); and the menubar icon reflects daemon health.

**Depends on**: Phase 2

**Requirements**: MIGR-01, MIGR-02, MIGR-03, MIGR-04, MIGR-05, MIGR-06, SETT-01, SETT-02, SETT-03, SETT-04, SETT-05, SETT-06, SETT-07, SPEK-01, SPEK-02, LLGN-01, LLGN-02, DAEM-01, DAEM-02, DAEM-03, DAEM-04, DAEM-05, LOGS-01, LOGS-02, LOGS-03, MBAR-05, MBAR-08

**Success Criteria** (what must be TRUE):
  1. On first launch against an existing repo checkout, the app detects `.env` + `./data/` and offers to migrate; after confirming, API keys land in Keychain (visible as "PlaudNoteTaker" entry), state files land in `~/Library/Application Support/PlaudNoteTaker/` byte-for-byte (Eagle profile `ArrayBuffer`s preserved), the original `.env` + `./data/` are untouched, and a sentinel file prevents re-migration on subsequent launches.
  2. Once configured, the app polls Plaud on the configured interval using the existing pipeline code: new recordings are downloaded, transcribed, diarized, summarized, and written as Markdown to the vault — identical output to today's `plaud start` CLI. A single failed tick (network error, rate limit, 5xx) does not terminate the loop, and after sleep/wake the loop resumes with an immediate catch-up poll.
  3. User opens Settings (Cmd-, or context-menu item), enters/edits API keys (masked inputs, show/hide toggle, per-key Test Connection buttons), picks vault + templates folder via native directory picker, sets poll interval / Gemini model / selected template, and saves — values round-trip through Keychain/`settings.json` and the next poll tick uses them; Save is disabled while fields are invalid.
  4. Settings Speakers pane lists all enrolled profiles; Delete (with confirmation) removes a profile and the next speaker-identification run no longer matches it. "Launch at login" toggle persists across reboots and the app starts on next login without user interaction.
  5. A Logs tab streams live events from the existing `log` module (last ~1000 lines, auto-scroll with user-scroll-up pause, copy-to-clipboard button) — showing the same events the CLI `plaud start` prints today. On startup, if ffmpeg is missing, the app shows a clear error modal instead of failing silently on first poll.
  6. Closing any window (Settings, Logs) hides it to the menubar without quitting the daemon; the menubar icon switches to an error state when the last poll errored and back to idle when it succeeds.

**Plans**: 3 plans

Plans:
- [ ] 03-01: Migration + Keychain + config loader + startup sequence (ffmpeg check, lock, migrate, config, service facade, IPC, preload)
- [ ] 03-02: Poll loop with powerMonitor + AbortController + per-tick try/catch + ffmpeg resolver + single-instance coordination with CLI
- [ ] 03-03: Settings window (API keys / paths / interval / model / speakers / launch-at-login) + Logs tab + menubar icon state machine + close-to-menubar semantics

---

### Phase 4: User Surface — Popover, Notifications, HTTP Bridge

**Goal**: The app feels like a native macOS menubar tool — left-clicking the icon shows a popover with recent notes (72h, click-to-open in Obsidian) and Start/Stop/Poll-now controls, right-clicking opens a standard context menu, native notifications fire for newly saved notes and pipeline errors (click-to-open-in-Obsidian), and a loopback-only HTTP bridge exposes `/health` and `/label-speakers` for the Obsidian plugin to call.

**Depends on**: Phase 3

**Requirements**: POPO-01, POPO-02, POPO-03, POPO-04, POPO-05, POPO-06, MBAR-03, MBAR-04, NOTF-01, NOTF-02, NOTF-03, NOTF-04, BRDG-01, BRDG-02, BRDG-03, BRDG-04, BRDG-05, BRDG-06

**Success Criteria** (what must be TRUE):
  1. Left-clicking the menubar icon opens a popover anchored under the icon showing the last 72 hours of saved notes (most-recent first, with title + vault-relative path + timestamp); clicking a note opens it in Obsidian via `obsidian://open`; clicking outside the popover dismisses it; when no notes exist yet, an empty state links to Settings.
  2. Popover exposes Poll-now, Start/Stop toggle (persisting across restarts), and a footer showing "Last poll: N ago" and "Last error: …" when applicable; right-clicking the menubar icon opens a context menu with at least Open Popover, Preferences, About/version, and Quit.
  3. When the pipeline saves a new note, a native macOS notification appears ("New note saved: {title}", subtitle = folder path), and clicking it opens the note in Obsidian. On pipeline errors (Plaud 429, AssemblyAI repeated failures, Gemini parse failure, config broken, ffmpeg missing), a native notification surfaces with an actionable message. Notifications group under "PlaudNoteTaker" in Notification Center.
  4. A loopback HTTP server binds to `127.0.0.1` only (verified unreachable from LAN), on an ephemeral port; `{port, token}` is written to `bridge.json` with 0600 permissions; `GET /health` returns `{ok: true, version}`; `POST /label-speakers {notePath}` runs the existing label-and-enroll flow for paths inside the configured vault only (rejects traversal) and returns `{ok, matched, enrolled}`; the server shuts down within 5s of Cmd-Q even with in-flight requests.

**Plans**: 3 plans

Plans:
- [ ] 04-01: Popover window (recent-notes list, controls, footer, empty state, obsidian:// open) + left-click + context menu with full entries (Open Popover, Preferences, About, Quit)
- [ ] 04-02: Native notifications (new-note + error) with click-to-open + `CFBundleIdentifier` grouping + first-launch permission handling
- [ ] 04-03: Hono loopback HTTP bridge (`/health`, `/label-speakers`) + `bridge.json` with 0600 perms + bearer token + vault-path validation + graceful shutdown

---

### Phase 5: Obsidian Plugin — Match Speakers Button

**Goal**: A standalone Obsidian plugin injects a "Match speakers" button inside any note containing an Unknown Speakers callout. Clicking the button sends the note path to the daemon's `/label-speakers` endpoint via Obsidian's `requestUrl()` API, the daemon runs today's label-and-enroll flow (updating the note in place), and the button reflects idle → spinner → success/error states. If the daemon is not running, the plugin shows a clear, non-fatal error.

**Depends on**: Phase 4

**Requirements**: PLUG-01, PLUG-02, PLUG-03, PLUG-04, PLUG-05, PLUG-06, PLUG-07

**Success Criteria** (what must be TRUE):
  1. In a note containing an Unknown Speakers callout, the plugin (via `registerMarkdownPostProcessor` + `MarkdownRenderChild`) renders exactly one "Match speakers" button — re-rendering the note does not duplicate or orphan buttons; notes without the callout show nothing.
  2. Clicking the button sends a POST to `http://127.0.0.1:<port>/label-speakers` using Obsidian's `requestUrl()` (not `fetch()`), with the bearer token read from `bridge.json`; the button shows tri-state status inline (idle → spinner "Matching…" → check or X + error message) and is disabled while pending.
  3. After a successful match, the daemon has updated the note in place (speakers labeled, Unknown Speakers callout removed); on the next render the button disappears because the callout no longer exists.
  4. If the daemon is not running or unreachable, the button shows an inline error and an Obsidian `Notice` ("PlaudNoteTaker is not running") without hanging the UI or throwing; the plugin does not crash Obsidian.
  5. The plugin ships a valid `manifest.json` with `minAppVersion`, and a `PluginSettingTab` that exposes a port override and a Test Connection button hitting `/health` and showing success/failure.

**Plans**: 2 plans

Plans:
- [ ] 05-01: Plugin scaffold (manifest, esbuild, settings tab with port + test connection) + `MarkdownRenderChild` button injection + idempotence guard + graceful daemon-unreachable handling
- [ ] 05-02: `requestUrl` label call with bearer token from `bridge.json` + tri-state UI + end-to-end verification against a real daemon

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 (decimal phases inserted as needed, e.g., 2 → 2.1 → 3)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Shared Seams | 1/1 | ✓ Complete | 2026-04-16 |
| 2. Electron Shell — Signed, Notarized, Eagle-Verified | 0/2 | Not started | - |
| 3. Core Daemon — Migration, Config, Poll Loop, Settings, Logs | 0/3 | Not started | - |
| 4. User Surface — Popover, Notifications, HTTP Bridge | 0/3 | Not started | - |
| 5. Obsidian Plugin — Match Speakers Button | 0/2 | Not started | - |

---
*Roadmap created: 2026-04-16*
