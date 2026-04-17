# Requirements: PlaudNoteTaker — macOS Menubar App

**Defined:** 2026-04-16
**Core Value:** New Plaud recordings land in Obsidian as polished notes without the user ever opening a terminal, and labeling unknown speakers is a single click inside the note.

## v1 Requirements

Derived from `.planning/research/FEATURES.md` P1 list, `.planning/PROJECT.md` Active section, and architectural seams from `.planning/research/ARCHITECTURE.md`. Every P1 item from research is captured.

### Shared Code Refactor (CLI must keep working)

- [ ] **SHAR-01**: `src/state.ts` accepts data dir as an argument/param rather than reading `config.dataDir` internally, so both the CLI and the app can pass different locations without code duplication
- [ ] **SHAR-02**: Config loading is split into two source-specific loaders (one reads `.env` for the CLI, one reads Keychain + JSON for the app) that both produce the same `Config` type
- [ ] **SHAR-03**: `src/log.ts` exposes a pub/sub sink interface so the app can attach an in-memory buffer + IPC emitter while the CLI continues writing to the console
- [ ] **SHAR-04**: Existing `npx tsx src/index.ts {init,start,label,speakers,test}` commands continue to work unchanged after the refactor (regression test against the current CLI behavior)

### Scaffold & Packaging

- [ ] **SCAF-01**: Project builds a `.app` installable to `/Applications` using Electron Forge (Vite template), launching like any native macOS app
- [ ] **SCAF-02**: The `.app` is signed with the user's Apple Developer ID certificate and notarized via Apple's `notarytool` service, producing a DMG that passes Gatekeeper without right-click-Open
- [ ] **SCAF-03**: `@picovoice/eagle-node` loads and runs `EagleProfiler` / `Eagle` in the Electron main process of the packaged app (verified by a smoke test that constructs and immediately releases both classes)
- [ ] **SCAF-04**: `ffmpeg` is bundled as an app resource via `ffmpeg-static`, is code-signed during the build's `afterSign` step, and the packaged app successfully invokes it (no reliance on `brew install ffmpeg`)
- [ ] **SCAF-05**: Hardened-runtime entitlements plist includes `com.apple.security.cs.allow-jit` and `com.apple.security.cs.disable-library-validation`, and excludes `com.apple.security.cs.allow-unsigned-executable-memory` (harmful on Electron 12+)

### Menubar Presence & Lifecycle

- [ ] **MBAR-01**: A menubar icon appears using a macOS template image (`*Template.png` + `@2x`) that adapts automatically to light/dark menu bars
- [ ] **MBAR-02**: The app is hidden from the Dock (`LSUIElement=true` in Info.plist)
- [ ] **MBAR-03**: Left-clicking the menubar icon opens a popover anchored under the icon; clicking away dismisses it
- [ ] **MBAR-04**: Right-clicking (or alt-clicking) the menubar icon opens a context menu with at least: Open Popover, Preferences, About / version string, Quit
- [ ] **MBAR-05**: Closing a window (popover, Settings, Logs) hides it to the menubar without quitting the daemon
- [ ] **MBAR-06**: Cmd-Q and the Quit menu item fully quit the app and stop the poll loop
- [ ] **MBAR-07**: Only one instance of the app can run at a time — launching a second instance focuses the existing one rather than starting a parallel daemon (`app.requestSingleInstanceLock()`)
- [ ] **MBAR-08**: The menubar icon reflects daemon state in at least two visually-distinct forms: idle (normal) and error (e.g., exclaim overlay)

### Popover: Recent Notes & Controls

- [ ] **POPO-01**: Popover displays the last 72 hours of saved notes sourced from `processing-history.json`, most-recent first, with title + vault-relative path + timestamp
- [ ] **POPO-02**: Clicking a recent note opens it in Obsidian via the `obsidian://open?path=...` URI scheme
- [ ] **POPO-03**: Popover shows a "Poll now" button that triggers an immediate poll, independent of the scheduled interval
- [ ] **POPO-04**: Popover shows a Start/Stop toggle that pauses/resumes the poll loop (state persists across app restarts)
- [ ] **POPO-05**: Popover footer shows "Last poll: N ago" (time since last successful poll) and, if an error occurred on the last tick, "Last error: {message}"
- [ ] **POPO-06**: When no notes exist yet in history, the popover shows an empty state ("No notes yet. New recordings will appear here.") and links to Settings if unconfigured

### Settings Window

- [ ] **SETT-01**: A dedicated Settings window (separate `BrowserWindow`, ~640×480, tabbed sidebar) is reachable from the context menu and from a gear icon in the popover
- [ ] **SETT-02**: API key fields (Plaud bearer token, AssemblyAI, Gemini, Picovoice) are masked by default with a show/hide toggle; values are written to Electron `safeStorage` (macOS Keychain-backed), never to disk in cleartext
- [ ] **SETT-03**: Each API key field has a "Test connection" button that runs the existing connection-test code and shows success (green check) or failure (red X + error message) inline
- [ ] **SETT-04**: Vault path and templates-folder path fields use `dialog.showOpenDialog({properties:['openDirectory']})` for selection, not free text
- [ ] **SETT-05**: Settings include selected template (dropdown sourced from the templates folder), poll interval (numeric, seconds), Gemini model (text)
- [ ] **SETT-06**: Save button is disabled when any field is invalid (missing required path, non-numeric interval, etc.); inline validation errors are shown per field
- [ ] **SETT-07**: Settings window is reached via Cmd-, (standard macOS Preferences shortcut) when the app is focused

### Speaker Management

- [ ] **SPEK-01**: Settings has a Speakers pane that lists all enrolled speaker profile names from `speaker-profiles.json`
- [ ] **SPEK-02**: Each listed speaker has a Delete action that removes the profile (with confirmation dialog)

### Launch at Login

- [ ] **LLGN-01**: Settings has a "Launch at login" toggle that uses `app.setLoginItemSettings({openAtLogin, type: 'mainAppService'})` (SMAppService-backed on macOS 13+)
- [ ] **LLGN-02**: After toggling on, the app launches automatically on next Mac restart and resumes polling without user interaction

### Daemon Reliability

- [ ] **DAEM-01**: The poll loop runs in the Electron main process using a self-rescheduling `setTimeout` chain (not `setInterval`), so ticks cannot overlap
- [ ] **DAEM-02**: Each poll tick is wrapped in try/catch so a single failed tick (network error, Plaud rate limit, AssemblyAI 5xx) never terminates the loop
- [ ] **DAEM-03**: On system resume (`powerMonitor.on('resume')`), the app triggers an immediate poll after a brief debounce to catch up on any recordings added during sleep
- [ ] **DAEM-04**: On startup, the app verifies the bundled `ffmpeg` binary is present and executable; if missing, it surfaces a clear error modal instead of failing silently during the first poll
- [ ] **DAEM-05**: In-flight HTTP requests (Plaud, AssemblyAI, Gemini) use `AbortController` so they can be cancelled on shutdown / sleep without leaking connections

### Notifications

- [ ] **NOTF-01**: When a new note is saved, the app posts a native macOS notification: "New note saved: {title}" (subtitle: vault-relative folder path)
- [ ] **NOTF-02**: Clicking a "new note" notification opens the saved note in Obsidian via `obsidian://open?path=...`
- [ ] **NOTF-03**: On pipeline errors (Plaud 429 quota, AssemblyAI repeated failures, Gemini parse failure, config broken, ffmpeg missing) the app posts a native notification with an actionable message
- [ ] **NOTF-04**: `CFBundleIdentifier` is set in Info.plist so Notification Center groups notifications under "PlaudNoteTaker"

### Logs Tab

- [ ] **LOGS-01**: A Logs tab in the Settings window shows a live stream of events from the `log` module (last ~1000 lines in an in-memory ring buffer), including the same events the CLI `plaud start` prints today
- [ ] **LOGS-02**: The Logs tab auto-scrolls to the newest entry unless the user has scrolled up (in which case it holds position)
- [ ] **LOGS-03**: A "Copy logs" button copies the current buffer to the clipboard for sharing / debugging

### First-Run Migration

- [ ] **MIGR-01**: On first launch, the app offers to import an existing setup: it looks for `.env` and `data/` in likely locations (the repo directory and user-supplied via a picker) and shows a modal: "Found existing setup at X. Migrate?"
- [ ] **MIGR-02**: On "Migrate", API key values from `.env` are written to Electron `safeStorage`; state files (`processed-recordings.json`, `recording-meta.json`, `processing-history.json`, `speaker-profiles.json`) are copied byte-for-byte into `~/Library/Application Support/PlaudNoteTaker/`
- [ ] **MIGR-03**: Migration is atomic: new state lands in a staging directory, a sentinel file is written on success, and only then is the staging directory renamed to final. If interrupted, the app detects an incomplete migration and re-runs it on next launch
- [ ] **MIGR-04**: Speaker profile bytes are preserved exactly (base64 round-trip without re-encoding) so Eagle profiles remain usable after migration
- [ ] **MIGR-05**: Original `.env` and `data/` files are left untouched — migration is a copy, not a move
- [ ] **MIGR-06**: If no existing setup is found, the app opens the Settings window automatically so the user can configure from scratch

### Local HTTP Bridge (for Obsidian plugin)

- [ ] **BRDG-01**: The app runs a local HTTP server (Hono) bound explicitly to `127.0.0.1` (not `0.0.0.0`), so nothing on the LAN can reach it
- [ ] **BRDG-02**: Bridge exposes `GET /health` returning `{ok: true, version: "..."}` for plugin liveness checks
- [ ] **BRDG-03**: Bridge exposes `POST /label-speakers` accepting `{notePath}` which runs the existing label-and-enroll flow (equivalent to today's `plaud label <file>`) and returns `{ok, matched: N, enrolled: M}` or `{ok: false, error}`
- [ ] **BRDG-04**: Bridge port and a generated bearer token are written to `~/Library/Application Support/PlaudNoteTaker/bridge.json` with 0600 permissions; the plugin reads this file to discover both
- [ ] **BRDG-05**: Bridge validates path inputs to `/label-speakers` are inside the configured vault (no directory traversal to arbitrary paths)
- [ ] **BRDG-06**: Bridge shuts down cleanly on `before-quit` with a 5-second timeout for in-flight requests to finish

### Obsidian Plugin

- [ ] **PLUG-01**: Plugin renders a "Match speakers" button inside any note that contains an Unknown Speakers callout, injected via `registerMarkdownPostProcessor` wrapped in a `MarkdownRenderChild`
- [ ] **PLUG-02**: Button injection is idempotent — re-rendering the same note does not duplicate the button
- [ ] **PLUG-03**: On click, the plugin POSTs `{notePath}` to the daemon's `/label-speakers` endpoint using Obsidian's `requestUrl()` API (not `fetch()`), with the bearer token read from `bridge.json`
- [ ] **PLUG-04**: Button shows tri-state status inline: idle → spinner → success (check) or error (X + message text); disabled while request is pending
- [ ] **PLUG-05**: If the daemon is not reachable, the plugin shows a clear message ("PlaudNoteTaker is not running") via an inline error and an Obsidian `Notice`, without hanging or throwing
- [ ] **PLUG-06**: Plugin ships a valid `manifest.json` with correct `minAppVersion` and a settings tab (`PluginSettingTab`) that allows overriding the port and running a test connection against `/health`
- [ ] **PLUG-07**: After a successful match, the note is updated by the daemon (as today) and the button disappears on the next render

## v2 Requirements

Deferred to future milestones. Listed so they don't get re-invented.

### Post-v1 Polish

- **P2-01**: Tooltip on menubar icon showing "Last poll: N ago"
- **P2-02**: "Reveal in Finder" context-menu item on recent-notes list
- **P2-03**: Obsidian plugin status-bar item (colored dot = daemon health)
- **P2-04**: Obsidian plugin command-palette command: "Match speakers for current note"
- **P2-05**: User-configurable global keyboard shortcut to open the popover (default unset)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep and re-invention.

| Feature | Reason |
|---------|--------|
| Reprocess-recordings UI | User explicitly dropped during questioning — the goal is to wrap existing functionality, not extend it. CLI still works for reprocessing. |
| Auto-update (electron-updater / GitHub Releases) | Single-user milestone; rebuild-and-drag-to-Applications is fine. |
| Windows / Linux builds | macOS-only target. Keychain, menubar conventions, notarization are all macOS-specific. |
| Mac App Store distribution | Sandboxing incompatible with bundled ffmpeg shell-out and writing outside the sandbox. |
| Public distribution / GitHub Releases | Single-user tool. |
| Triggering recording from Obsidian | Plaud device handles recording; plugin is intentionally read-only except for the speaker-match button. |
| Full note browser / search / filter inside the app | Obsidian is the canonical note browser; duplicating it would be wasteful and inferior. |
| LAN / remote access to the daemon | Bridge is `127.0.0.1`-only by explicit design decision. |
| Additional authentication layer on the local bridge | Loopback + single-user machine + bearer token in 0600 file is sufficient. |
| Crash reporting / telemetry | Single user is their own telemetry. Local logs suffice. |
| Menubar-icon spinning-animation during polling | Visual noise; static idle/error states are clearer. |
| Logs persisted to disk / log rotation | In-memory ring buffer + copy-to-clipboard is enough for a personal tool. |
| Sound on notifications | Silent by default. |
| Keychain-backed secret sync across devices | Single machine; overkill. |
| Welcome tour / tutorial overlays | User built the thing; first-run auto-opens Settings. That's the onboarding. |
| In-app "About" window | Right-click context menu with version string is enough. |
| Obsidian plugin: inject buttons on all notes (not just notes with Unknown Speakers) | Visual pollution on unrelated notes. Post-processor targets the callout only. |
| Obsidian plugin: ribbon icon + sidebar view | No value; button lives in the note. |
| Obsidian plugin: internal retry / queueing of failed requests | Daemon already has retry logic; plugin stays stateless. |
| Obsidian plugin: WebSocket / SSE for live status | Single synchronous POST is simpler and sufficient for a seconds-long operation. |

## Traceability

Each v1 requirement maps to exactly one phase. See `.planning/ROADMAP.md` for phase details.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SHAR-01 | Phase 1 — Shared Seams | Complete |
| SHAR-02 | Phase 1 — Shared Seams | Complete |
| SHAR-03 | Phase 1 — Shared Seams | Complete |
| SHAR-04 | Phase 1 — Shared Seams | Complete |
| SCAF-01 | Phase 2 — Electron Shell | Pending |
| SCAF-02 | Phase 2 — Electron Shell | Pending |
| SCAF-03 | Phase 2 — Electron Shell | Pending |
| SCAF-04 | Phase 2 — Electron Shell | Pending |
| SCAF-05 | Phase 2 — Electron Shell | Pending |
| MBAR-01 | Phase 2 — Electron Shell | Pending |
| MBAR-02 | Phase 2 — Electron Shell | Pending |
| MBAR-06 | Phase 2 — Electron Shell | Pending |
| MBAR-07 | Phase 2 — Electron Shell | Pending |
| MIGR-01 | Phase 3 — Core Daemon | Pending |
| MIGR-02 | Phase 3 — Core Daemon | Pending |
| MIGR-03 | Phase 3 — Core Daemon | Pending |
| MIGR-04 | Phase 3 — Core Daemon | Pending |
| MIGR-05 | Phase 3 — Core Daemon | Pending |
| MIGR-06 | Phase 3 — Core Daemon | Pending |
| SETT-01 | Phase 3 — Core Daemon | Pending |
| SETT-02 | Phase 3 — Core Daemon | Pending |
| SETT-03 | Phase 3 — Core Daemon | Pending |
| SETT-04 | Phase 3 — Core Daemon | Pending |
| SETT-05 | Phase 3 — Core Daemon | Pending |
| SETT-06 | Phase 3 — Core Daemon | Pending |
| SETT-07 | Phase 3 — Core Daemon | Pending |
| SPEK-01 | Phase 3 — Core Daemon | Pending |
| SPEK-02 | Phase 3 — Core Daemon | Pending |
| LLGN-01 | Phase 3 — Core Daemon | Pending |
| LLGN-02 | Phase 3 — Core Daemon | Pending |
| DAEM-01 | Phase 3 — Core Daemon | Pending |
| DAEM-02 | Phase 3 — Core Daemon | Pending |
| DAEM-03 | Phase 3 — Core Daemon | Pending |
| DAEM-04 | Phase 3 — Core Daemon | Pending |
| DAEM-05 | Phase 3 — Core Daemon | Pending |
| LOGS-01 | Phase 3 — Core Daemon | Pending |
| LOGS-02 | Phase 3 — Core Daemon | Pending |
| LOGS-03 | Phase 3 — Core Daemon | Pending |
| MBAR-05 | Phase 3 — Core Daemon | Pending |
| MBAR-08 | Phase 3 — Core Daemon | Pending |
| POPO-01 | Phase 4 — User Surface | Pending |
| POPO-02 | Phase 4 — User Surface | Pending |
| POPO-03 | Phase 4 — User Surface | Pending |
| POPO-04 | Phase 4 — User Surface | Pending |
| POPO-05 | Phase 4 — User Surface | Pending |
| POPO-06 | Phase 4 — User Surface | Pending |
| MBAR-03 | Phase 4 — User Surface | Pending |
| MBAR-04 | Phase 4 — User Surface | Pending |
| NOTF-01 | Phase 4 — User Surface | Pending |
| NOTF-02 | Phase 4 — User Surface | Pending |
| NOTF-03 | Phase 4 — User Surface | Pending |
| NOTF-04 | Phase 4 — User Surface | Pending |
| BRDG-01 | Phase 4 — User Surface | Pending |
| BRDG-02 | Phase 4 — User Surface | Pending |
| BRDG-03 | Phase 4 — User Surface | Pending |
| BRDG-04 | Phase 4 — User Surface | Pending |
| BRDG-05 | Phase 4 — User Surface | Pending |
| BRDG-06 | Phase 4 — User Surface | Pending |
| PLUG-01 | Phase 5 — Obsidian Plugin | Pending |
| PLUG-02 | Phase 5 — Obsidian Plugin | Pending |
| PLUG-03 | Phase 5 — Obsidian Plugin | Pending |
| PLUG-04 | Phase 5 — Obsidian Plugin | Pending |
| PLUG-05 | Phase 5 — Obsidian Plugin | Pending |
| PLUG-06 | Phase 5 — Obsidian Plugin | Pending |
| PLUG-07 | Phase 5 — Obsidian Plugin | Pending |

**Coverage:**
- v1 requirements: 65 total
- Mapped to phases: 65
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-16*
*Traceability populated: 2026-04-16 by roadmapper*
