# PlaudNoteTaker

## What This Is

PlaudNoteTaker is a self-hosted pipeline that turns Plaud voice recordings into structured Obsidian notes (transcribe → diarize → identify speakers → summarize → file in vault). The current milestone wraps the existing CLI in a macOS menubar app so the pipeline runs as a normal installed application instead of a long-lived terminal session, with a companion Obsidian plugin that replaces the `plaud label` command with a one-click button.

## Core Value

New Plaud recordings land in Obsidian as polished notes without the user ever opening a terminal, and labeling unknown speakers is a single click inside the note.

## Requirements

### Validated

<!-- Existing CLI capabilities, shipped in v0.1.0 and relied upon. -->

- ✓ Poll Plaud cloud every N seconds and detect new recordings — existing
- ✓ Download OGG audio from Plaud and convert to WAV via ffmpeg — existing
- ✓ Transcribe with AssemblyAI `universal-3-pro` including speaker diarization — existing
- ✓ Identify enrolled speakers via Picovoice Eagle (with 30s-per-speaker quota conservation) — existing
- ✓ Summarize transcript with Google Gemini using a customizable prompt template — existing
- ✓ Smart folder routing — Gemini picks a target vault folder from the vault tree — existing
- ✓ Write structured markdown notes (title, attendees, summary, action items, transcript, unknown-speakers callout) — existing
- ✓ Label unknown speakers in a note, replace `Speaker A/B/C` with real names, and enroll voices via `plaud label <file>` — existing
- ✓ Speaker profile management (`plaud speakers list/delete`) — existing
- ✓ Interactive `plaud init` that collects API keys, tests connections, writes `.env` — existing
- ✓ Processed-ID deduplication, processing history, recording metadata stored in `data/*.json` — existing
- ✓ Rate-limit + retry handling for Plaud API; AssemblyAI transcription retry on retryable errors — existing

### Active

<!-- This milestone: Electron menubar wrapper + Obsidian plugin. -->

**Menubar app (Electron, macOS)**

- [ ] Installable to `/Applications`, signed + notarized with the user's existing Apple Developer ID, launches like any native macOS app
- [ ] Launches at login (toggle in Settings), lives in the menubar, hidden from the Dock
- [ ] Click menubar icon → popover showing recent notes (72h history from existing `processing-history.json`) with click-to-open-in-Obsidian
- [ ] Polling loop runs in the Electron main process, using the existing `src/*.ts` modules directly (no CLI subprocess, no feature regression)
- [ ] Start / stop / "poll now" controls from the popover
- [ ] Settings window: API keys (Plaud, AssemblyAI, Gemini, Picovoice) stored in macOS Keychain; vault path, fallback folder, templates folder, selected template, poll interval, Gemini model editable in UI
- [ ] Speaker management pane: list enrolled profiles, delete a profile
- [ ] Live log stream visible in a Logs tab (same events the CLI prints today)
- [ ] macOS native notifications: "New note saved: {title}" (click → open note in Obsidian) and error toasts (quota exceeded, API down, config broken)
- [ ] First-run migration: detect existing `.env` + `data/` in the repo directory, import API keys into Keychain, copy state (`processed-recordings.json`, `recording-meta.json`, `processing-history.json`, `speaker-profiles.json`) into the app's own data dir (`~/Library/Application Support/PlaudNoteTaker/`). Old files untouched.
- [ ] Local HTTP bridge on `127.0.0.1` (loopback only) exposing endpoints for the Obsidian plugin to call

**Obsidian plugin**

- [ ] Renders a "Match speakers" button inside any note that contains an Unknown Speakers callout
- [ ] On click: POSTs the note path to the menubar app's localhost endpoint, which runs the existing label+enroll flow, updates the note, and removes the Unknown Speakers section — same outcome as today's `plaud label <file>` command
- [ ] Shows a status indicator (running / success / error with message)

**Shared**

- [ ] Existing CLI (`npx tsx src/index.ts ...`) continues to work unchanged. The Electron app and CLI both import from `src/*.ts`; no code is duplicated or forked.

### Out of Scope

- **Reprocess-recordings feature** — explicitly dropped during questioning. The point is to wrap existing functionality, not add new pipeline features.
- **Auto-update (electron-updater + GitHub Releases)** — this is a personal tool for one user. A rebuild-and-drag-to-Applications flow is fine.
- **Windows / Linux builds** — macOS-only. The target platform is specifically macOS menubar.
- **Triggering recording from Obsidian** — Plaud device handles recording; the Obsidian plugin is read-only except for the speaker-match button.
- **Full note search / filter / browse UI** — "recent notes" popover is enough; Obsidian is the canonical note browser.
- **Remote access / web UI / LAN access** — HTTP bridge is `127.0.0.1` only. No mobile or remote management.
- **Public distribution (App Store, Homebrew tap, unsigned DMG for strangers)** — single user, direct install from locally-built artifact.
- **Rewriting the existing pipeline** — the Electron app is a wrapper; it does not change transcription, summarization, folder routing, or speaker recognition logic.

## Context

**Codebase starting point (from `.planning/codebase/`):**

- TypeScript, ESM, Node 18+, `tsx` for dev execution, `tsc` for build. No existing bundler.
- Runtime deps: `dotenv`, `@picovoice/eagle-node` (native module — requires rebuild against Electron's Node ABI via `@electron/rebuild`).
- Hard external deps: `ffmpeg` binary on `PATH`. The Electron app will need to bundle ffmpeg as a resource so the installed app is truly self-contained.
- State dir today: `./data/` relative to `process.cwd()` — hard-coded via `DATA_DIR` env var. The app will point this at `~/Library/Application Support/PlaudNoteTaker/` and migrate existing state on first launch.
- All external calls are plain `fetch` — no SDKs. Nothing about the pipeline assumes it runs in a CLI context.

**Prior art referenced by README:**

- A personal Obsidian plugin was the original proof-of-concept before this became a CLI. The "Match speakers" button spiritually returns that UX to Obsidian.

**Known issues surfaced by `.planning/codebase/CONCERNS.md` (not blockers but worth noting in case they surface during wrapper work):**

- Synchronous file I/O in the poll loop (`state.ts`) — may cause perceptible pauses as history grows. Electron's renderer ↔ main IPC should avoid compounding this.
- ffmpeg availability has no runtime re-check after startup — the app must verify ffmpeg is present (bundled or on PATH) and fail loudly if not.
- `parseSummaryOutput` silently falls back to default folder when Gemini skips the `FOLDER:` line — the app should surface this in logs so the user can debug template changes.
- Eagle enrollment logs via `console.warn` instead of the `log` module — low priority.

## Constraints

- **Tech stack**: Electron + TypeScript for the app shell; existing `src/*.ts` modules run in the Electron main process — Chosen to reuse 100% of pipeline code without duplication and because `@picovoice/eagle-node` only runs in a Node-compatible process (not a browser/webview/Tauri main).
- **Dependencies**: Must bundle ffmpeg as an app resource — "self-contained" is a goal; users should not have to `brew install ffmpeg` before launching.
- **Platform**: macOS only (menubar, Keychain, notarization). No cross-platform target.
- **Distribution**: Signed + notarized via the user's existing Apple Developer ID. Not submitted to the Mac App Store (sandboxing is incompatible with shelling out to ffmpeg and writing outside the sandbox).
- **Security**: Local HTTP bridge binds to `127.0.0.1` only. API keys live in macOS Keychain, not `.env`, once migrated.
- **Compatibility**: Existing CLI must continue to work. The Electron app and CLI share one source tree; no divergent branches.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Electron menubar app over Tauri | `@picovoice/eagle-node` is a native Node module; Electron main process runs it as-is, Tauri would require a Node sidecar which defeats "self-contained" | — Pending |
| Run pipeline in Electron main process (not a spawned CLI subprocess) | Shared in-memory state, live status updates, simpler IPC to renderer. Requires `@electron/rebuild` against Electron's Node ABI — one-line postinstall. | — Pending |
| Obsidian plugin talks to menubar app via `127.0.0.1` HTTP | Clean separation; plugin stays a pure JS bundle with no Node native deps; loopback-only binding means no LAN exposure, no auth needed for a single-user tool | — Pending |
| Popover UI for the menubar icon (not a full window) | Native macOS feel (Fantastical, Things style); Settings and Logs live in a separate window when needed | — Pending |
| Bundle ffmpeg as an app resource | "Self-contained" requirement; avoids Homebrew dependency; licensing is compatible (LGPL with dynamic linking OR a static build of the ffmpeg binary is redistributable) | — Pending |
| Store API keys in macOS Keychain | More secure than `.env`, unlocks clean in-app onboarding, survives app reinstall | — Pending |
| Data dir moves to `~/Library/Application Support/PlaudNoteTaker/` | Standard macOS location for app state; decouples from the repo's working directory; import-existing-state on first launch preserves history and speaker profiles | — Pending |
| Existing CLI remains supported | App and CLI share `src/*.ts`; no maintenance cost; useful for debugging and scripting | — Pending |
| No auto-update (electron-updater) in v1 | Single user; rebuild-and-drag installs are fine; avoids GitHub Releases infra | — Pending |

---
*Last updated: 2026-04-16 after initialization*
