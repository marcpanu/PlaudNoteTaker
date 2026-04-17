# Project Research Summary

**Project:** PlaudNoteTaker — Electron Menubar App + Obsidian Plugin milestone
**Domain:** macOS menubar daemon wrapping an existing Node/TypeScript CLI pipeline; companion Obsidian plugin over loopback HTTP
**Researched:** 2026-04-16
**Confidence:** HIGH overall (one unverified load-bearing assumption: Eagle N-API compatibility in Electron 41 — mandatory smoke test)

## Executive Summary

PlaudNoteTaker already has a complete, working recording-to-note pipeline. This milestone is not about building new pipeline logic — it is about wrapping the existing `src/*.ts` modules in an Electron main process so the pipeline runs as a first-class macOS application (menubar icon, Keychain secrets, native notifications, launch at login) instead of a long-lived terminal session. The recommended approach is Electron 41 + Electron Forge + Vite, with the pipeline unchanged and all new Electron-specific code isolated to a new `src/app/` folder that can be deleted without breaking the CLI. The one architectural constraint that drives all technology choices is `@picovoice/eagle-node`: it is a native Node module that runs only in Node-compatible processes, which makes Electron (and not Tauri) the correct shell.

The core architectural insight from research is the service facade pattern: a single `src/app/svc.ts` object whose methods are called by both IPC handlers (renderer → main) and HTTP handlers (Obsidian plugin → main). This single surface owns the reentrancy lock, which prevents concurrent poll and label operations from racing on shared JSON state files. Everything else — tray icon, settings window, logs renderer, HTTP bridge — is thin glue around this facade. The three injection seams (config loader, log pub/sub, data-dir resolver) are the only changes needed to existing `src/*.ts` files; every other module is untouched.

The highest-risk items are all in the packaging and signing phase rather than in the application logic: Eagle's `.node` binary must be rebuilt against Electron's Node ABI (not the system ABI), the bundled ffmpeg binary must be individually code-signed before notarization, and the hardened runtime entitlements plist must include `disable-library-validation` for the Eagle native module to load. All three are well-understood, one-time problems that the research has documented precisely. First-run state migration (copying `./data/*.json` and Eagle profile ArrayBuffers into `~/Library/Application Support/PlaudNoteTaker/`) is the highest-stakes user-data operation and must be implemented atomically with rollback.

## Key Findings

### Recommended Stack

The stack is Electron 41 (Node 24.14 / Chromium 146) scaffolded via Electron Forge with the Vite-TypeScript template, matching the repo's existing TypeScript/ESM toolchain. `@electron/rebuild` is wired as a `postinstall` script to rebuild `@picovoice/eagle-node` against Electron's ABI. A conservative fallback to Electron 40 is available if the Eagle smoke test fails. `electron-store` holds non-secret app config (poll interval, vault path, template selection) under `~/Library/Application Support/PlaudNoteTaker/`; Electron's built-in `safeStorage` holds API keys (Keychain-backed, zero native dep, eliminates the archived `keytar`). Hono (`@hono/node-server`) runs the 2-endpoint loopback HTTP bridge — tiny, zero-dep, first-class TypeScript. `ffmpeg-static` provides the bundled ffmpeg binary (arm64 + x86_64); it must be declared in Forge's `extraResources`/`asarUnpack` and explicitly re-signed in the `afterSign` hook before notarization. The `menubar` npm package (v9.5.2) handles tray anchoring for speed; raw `Tray` + `BrowserWindow` is the fallback for polish. The Obsidian plugin uses the standard `obsidian-sample-plugin` template with `esbuild`, and must use Obsidian's `requestUrl()` API — not `fetch()` — to avoid CORS from the `app://obsidian.md` origin.

**Core technologies:**
- **Electron 41**: App shell; runs Eagle native module in-process — HIGH
- **Electron Forge + Vite plugin**: Build, sign, notarize, package — replaces ad-hoc shell scripts — HIGH
- **`@electron/rebuild`**: Rebuilds `eagle-node` against Electron ABI on `postinstall` — HIGH
- **`safeStorage` (built-in)**: Keychain-backed API key storage; replaces `.env` — HIGH
- **Hono + `@hono/node-server`**: Loopback HTTP bridge (`POST /label`, `GET /health`) — HIGH
- **`ffmpeg-static`**: Bundled ffmpeg; needs `afterSign` codesign + LGPL attribution — HIGH
- **`electron-store`**: Non-secret app config persistence — HIGH
- **`menubar` npm**: Tray popover positioning — HIGH
- **Obsidian `requestUrl()`**: CORS-safe loopback HTTP from plugin — HIGH

### Expected Features

All features below are P1 for this milestone; none are aspirational. The scope is deliberately a wrapper around validated functionality, not new pipeline capability.

**Must have (table stakes) — missing any of these makes the app feel broken:**
- Menubar icon with template image (adapts to light/dark), left-click popover, right-click context menu (Quit / Settings / version)
- `LSUIElement=true` in Info.plist (no Dock icon ever, no flicker), single-instance lock
- Close-window hides to menubar; Cmd-Q truly quits (most-complained-about Electron menubar bug)
- Icon status states: idle / error (2–3 static states, no animation during polling)
- Polling continues while no windows are open; daemon survives display sleep/wake via `powerMonitor`
- Native notification on "new note saved" (click → open in Obsidian) and on errors
- Settings window (separate `BrowserWindow`, not inside popover): API keys with Keychain storage + masked inputs + test-connection buttons; vault/templates folder pickers via `dialog.showOpenDialog`; poll interval; speaker management pane
- Live log stream (ring buffer, last ~1000 lines, copy-to-clipboard)
- First-run migration: detect `.env` + `./data/`, migrate atomically to `~/Library/Application Support/PlaudNoteTaker/`, sentinel file to prevent re-migration
- Local HTTP bridge on `127.0.0.1` only: `POST /label-speakers`, `GET /health`
- Obsidian plugin: "Match speakers" button injected via `registerMarkdownPostProcessor` on notes containing the Unknown Speakers callout; tri-state status (idle / spinner / check-X); `requestUrl()` for HTTP; settings tab with port + test-connection
- Signed + notarized build via user's Developer ID (prerequisite: launch-at-login, Keychain-without-prompting, reliable notification delivery all degrade on unsigned builds)

**Should have (low-cost polish worth including):**
- "Poll now", start/stop controls in popover; recent notes list (72h) with click-to-open
- Launch-at-login toggle (requires signed build for reliable `SMAppService` behavior on macOS 13+)
- Popover footer: "Last poll: X ago" / "Last error: ..."
- ffmpeg presence verified at startup with loud failure modal if absent
- Per-tick try/catch in poll loop (one failed poll must not kill the loop)
- `powerMonitor` resume hook triggers immediate re-poll + cancels in-flight requests on suspend

**Defer (v2+):**
- Auto-update (`update-electron-app` + GitHub Releases) — explicitly out of scope
- Obsidian plugin status bar health dot — add only if daemon-not-running issue bites in practice
- Global shortcut for popover (user-configurable, default unset)
- Reveal-in-Finder on recent notes right-click menu

**Anti-features (explicitly not building):**
- Full note browser in popover (Obsidian is the canonical note browser)
- LAN / remote access (loopback-only, no auth needed on 127.0.0.1 for single-user)
- Reprocess-recordings UI, cross-platform builds, App Store distribution, auto-update, telemetry

### Architecture Approach

The architecture enforces one hard rule: `src/*.ts` must never import from `electron`. All Electron-specific code lives in `src/app/` (a new folder); deleting it must leave a working CLI. The three shared joints are `src/config/` (two loaders: `.env` for CLI, Keychain+`settings.json` for app, same `Config` type), `src/log/` (pub/sub with pluggable sinks — console for CLI, console+IPC-broadcast for app), and `src/app/paths.ts` (resolves data dir once at startup, injects into `state.ts` constructors). A single service facade (`src/app/svc.ts`) owns a reentrancy lock and exposes all pipeline operations; IPC handlers and HTTP handlers are one-liners that call `svc`. The poll loop runs in the Electron main process as a self-rescheduling `setTimeout` chain (not `setInterval`) — simpler than a `utilityProcess`, sufficient because the pipeline is I/O-bound. The Obsidian plugin reads `bridge.json` (ephemeral port + shared secret written to userData on startup) and calls the bridge via `requestUrl()`.

**Major components and responsibilities:**
1. **`src/app/main.ts`**: Startup sequencer (data-dir → lock → ffmpeg check → migrate → config → log sinks → service → HTTP bridge → IPC handlers → tray → poll loop — in that order)
2. **`src/app/svc.ts`**: Service facade — single mutation surface; reentrancy lock; called by both IPC and HTTP
3. **`src/app/poll.ts`**: Self-rescheduling `setTimeout` loop; `powerMonitor` suspend/resume integration
4. **`src/app/http.ts`**: Hono server bound to `127.0.0.1`; writes `bridge.json`; `POST /label`, `GET /health`
5. **`src/app/ipc.ts`**: `ipcMain.handle('svc:*')` wiring; delegates entirely to `svc`
6. **`src/app/preload.ts`**: `contextBridge.exposeInMainWorld('plaud', {...})`; typed IPC surface for renderers
7. **`src/app/secrets.ts`**: `safeStorage` wrapper; must be called only after `app.whenReady()` and after `app.setName()` is set
8. **`src/app/migrate.ts`**: Atomic first-run migration (`./data/` → userData); sentinel file; rollback on partial failure
9. **`src/app/renderer/`**: Popover, Settings, Logs — view-only, derive all state from main via IPC
10. **Obsidian plugin**: Reads `bridge.json`; injects button via `registerMarkdownPostProcessor` + `MarkdownRenderChild`

### Critical Pitfalls

The research identified 10 critical pitfalls. The top 5 with the highest impact on this specific project:

1. **Eagle native module ABI mismatch** — `@picovoice/eagle-node` ships prebuilt `.node` binaries for system Node ABI; without `@electron/rebuild` in `postinstall`, the packaged app crashes at the first Eagle call (not at startup). Prevention: `"postinstall": "electron-rebuild -f -w @picovoice/eagle-node"` + 20-line smoke test in the first Electron phase that constructs an `EagleProfiler` instance inside a packaged app. If it throws, fall back to Electron 40 before doing anything else.

2. **ffmpeg binary fails notarization or gets SIGKILL'd at runtime** — `ffmpeg-static` ships unsigned binaries. Every executable embedded in the `.app` must be individually codesigned with `--options=runtime` in an `afterSign` hook before notarization. Missing this causes either a failed notarization upload or a Gatekeeper SIGKILL when ffmpeg is spawned. Also verify the binary is arm64/universal (`lipo -archs`); the x64 binary on Apple Silicon goes through Rosetta and triggers additional Gatekeeper scrutiny.

3. **Hardened runtime entitlements missing `disable-library-validation`** — Eagle's `.node` binary is signed by Picovoice's Team ID, not the user's. Hardened runtime blocks loading `.node` files from foreign Team IDs by default. The entitlements plist must include `com.apple.security.cs.disable-library-validation`. Both `mac.entitlements` AND `mac.entitlementsInherit` in Forge config must have this; missing `entitlementsInherit` causes helper process crashes that are extremely hard to diagnose.

4. **Poll loop breaks after sleep/wake — `setInterval` does not catch up** — macOS suspends the Node event loop during sleep; `setInterval` does not queue missed ticks. After wake, AssemblyAI in-flight HTTP requests may surface as `ECONNRESET` or `ETIMEDOUT`. Prevention: use a self-rescheduling `setTimeout` chain; subscribe to `powerMonitor.on('resume')` to cancel in-flight requests (`AbortController.abort()`) and trigger an immediate poll; also note that `resume` fires twice on macOS (debounce it). Widen AssemblyAI retry logic to include network errors, not just "Internal server error" text.

5. **First-run state migration corrupts or loses existing data** — Six months of `processing-history.json`, enrolled Eagle profiles (serialized as `ArrayBuffer`s per commit `8d0a17b` — must preserve byte layout, not JSON round-trip), and dedup state in `processed-recordings.json` are all at risk. Prevention: copy to a staging directory first, only rename on full success (atomic), write a sentinel file (not inferred state), validate JSON parse after each copy, keep `./data/` untouched as the rollback anchor. Detect concurrent CLI before migrating (pidfile or `ps aux` scan).

Additionally: `safeStorage` must not be called before `app.whenReady()`, and `app.setName('PlaudNoteTaker')` must be set before any `safeStorage` call — otherwise the Keychain entry is named "Chromium Safe Storage" and the prompt fires on every launch (documented bug `electron/electron#45328`).

## Implications for Roadmap

Based on architecture dependencies discovered in research, a 5-phase structure is recommended. The ordering is driven by hard build-order constraints documented in ARCHITECTURE.md.

### Phase 0: Shared Seams (CLI stays green throughout)

**Rationale:** The three injection seams must exist before any Electron code is written, because they are the joints where CLI and app diverge. If they break, both CLI and app break simultaneously. These changes are mechanical and testable entirely without Electron.

**Delivers:** A refactored (but behavior-identical) `src/config/`, `src/log/`, and parameterized `src/state.ts`; `src/app/paths.ts` stub; existing CLI commands verified to still pass.

**Implements:**
- `src/config/loader-env.ts` (extract from current `config.ts`), `src/config/loader-app.ts` (stub), `src/config/validate.ts` (shared)
- `src/log/core.ts` with console sink; existing `src/log.ts` becomes a re-export (no callers change)
- `src/state.ts` gains a `dataDir` parameter; all callers updated
- `src/app/paths.ts` — `resolveDataDir('cli' | 'app')` with env override + fallback

**Avoids:** Anti-pattern 3 (pipeline code importing from `electron`); setting up a context where any `src/*` file must change its imports later.

**Research flag:** Standard refactor pattern; no research needed during planning.

### Phase 1: Electron Scaffold + Eagle Smoke Test

**Rationale:** Eagle ABI compatibility is the single highest-confidence-risk item in the entire project. It must be resolved before any other Electron work, because if Eagle fails in Electron 41 and we fall back to Electron 40, every subsequent phase has the correct Electron version. The smoke test is 20 lines; failing to run it first risks building on a broken foundation.

**Delivers:** A notarized `.app` that boots to a tray icon, has no Dock icon (`LSUIElement=true`), successfully constructs an `EagleProfiler` instance in the main process, and exits cleanly via right-click → Quit.

**Implements:**
- Electron Forge scaffold with Vite-TypeScript template
- `@electron/rebuild` in `postinstall`
- Eagle smoke test: `const { EagleProfiler } = require('@picovoice/eagle-node')` in main, construct with test key, log `eagle.version`, destroy
- `LSUIElement=true` in Info.plist via `forge.config.ts` (`packagerConfig.extendInfo`)
- Basic tray icon (template image, right-click menu with Quit), `app.dock.hide()` as belt-and-suspenders
- Single-instance lock (`app.requestSingleInstanceLock()`)
- Hardened runtime entitlements plist (`allow-jit`, `disable-library-validation`)
- First notarization run (catches ffmpeg signing issue and entitlements gaps early)

**Avoids:** Pitfall 1 (Eagle ABI mismatch), Pitfall 3 (entitlements), Pitfall 10 (LSUIElement misconfiguration).

**Research flag:** Signing/notarization is well-documented via Forge; Eagle smoke test result determines Electron 40 vs 41. Budget 2–3 notarization iterations.

### Phase 2: Core App — Keychain, Config, Migration, Service Facade, Poll Loop

**Rationale:** The poll loop cannot start until config is complete (key design constraint from ARCHITECTURE.md). Config cannot be loaded until Keychain is initialized. Migration must run before config loads. This entire phase is a prerequisite to any visible pipeline behavior in the app.

**Delivers:** The app polls Plaud on its configured interval using the existing pipeline, surfacing log events to a Logs renderer; API keys migrated from `.env` to Keychain; state migrated from `./data/` to userData; first-run Settings window opens if config is missing.

**Implements:**
- `src/app/secrets.ts`: `safeStorage` wrapper; `app.setName('PlaudNoteTaker')` before any call; gated behind `app.whenReady()`
- `src/config/loader-app.ts`: reads Keychain + `settings.json`
- `src/app/migrate.ts`: atomic staging-dir copy, sentinel file, JSON validation, Eagle ArrayBuffer preservation, path absolutization
- `src/app/svc.ts`: service facade with reentrancy lock, `createService({ config, dataDir })`
- `src/app/ipc.ts`: `ipcMain.handle('svc:*')` scaffold
- `src/app/preload.ts`: `contextBridge.exposeInMainWorld('plaud', {...})`
- `src/app/poll.ts`: self-rescheduling `setTimeout` loop; `powerMonitor` suspend/resume; per-tick try/catch
- IPC log sink: `webContents.send('log:event', batch)` with 50ms coalescer
- Logs renderer: ring buffer backfill on mount, append-only virtualized list
- Settings renderer (API Keys tab): masked inputs, test-connection buttons, vault + templates folder pickers, launch-at-login toggle
- `src/app/lock.ts`: pidfile mutual exclusion with CLI
- ffmpeg path resolver: `app.isPackaged ? path.join(process.resourcesPath, 'bin/ffmpeg') : 'ffmpeg'`; startup presence check with modal on failure

**Avoids:** Pitfall 4 (sleep/wake poll loop), Pitfall 5 (migration corruption), Pitfall 7 (Keychain prompt loop), Pitfall 9 (launch-at-login SMAppService), Anti-pattern 6 (poll before config).

**Research flag:** `powerMonitor` resume double-fire on macOS (debounce required — documented in `electron/electron#24803`). Migration chaos testing (kill mid-copy, verify rollback) is mandatory before this phase is considered done.

### Phase 3: Popover UI + Notifications + HTTP Bridge

**Rationale:** With the daemon running and logs visible, the popover and HTTP bridge can be built independently and in parallel. Notifications require a valid `CFBundleIdentifier` and a notarized build (both already done). The HTTP bridge must exist before the Obsidian plugin can be developed.

**Delivers:** A functional menubar app — tray icon reflects daemon state, popover shows recent notes and controls, native notifications fire on new notes/errors, Obsidian plugin's HTTP endpoint is reachable.

**Implements:**
- Popover renderer: recent notes list (72h from `processing-history.json`), click-to-open via `shell.openExternal('obsidian://open?path=...')`, start/stop/poll-now buttons, "Last poll: X ago" footer, "Processing: ..." live indicator during active poll
- Icon state machine: 2–3 static template images (idle / error); swap on `status:update` IPC events
- Native notifications: `new Notification({ title, body })` on note saved (click → open) and on errors; `CFBundleIdentifier` set for Notification Center grouping
- `src/app/http.ts`: Hono server on `127.0.0.1:0` (ephemeral); writes `{port, token}` to `bridge.json` (0600 perms); `POST /label-speakers`, `GET /health`; graceful shutdown in `before-quit` with 5s force-close timeout
- Settings renderer remaining tabs: Polling interval, Speakers pane (list + delete), Templates
- Close-window-to-menubar semantics: `window.on('close', e => { e.preventDefault(); window.hide() })`

**Avoids:** Pitfall 6 (HTTP bridge port/shutdown), Pitfall 10 (LSUIElement — already done), UX pitfall of silent failures.

**Research flag:** HTTP bridge port collision handling (EADDRINUSE retry logic); notification permission prompt first-launch behavior on macOS 14+. Both are well-understood but need empirical verification on a signed build.

### Phase 4: Obsidian Plugin

**Rationale:** The plugin is blocked on Phase 3 (HTTP bridge must exist to validate end-to-end). It is a distinct deliverable — separate build toolchain (`esbuild`), separate lifecycle — that can be developed in a focused sprint once the daemon side is stable.

**Delivers:** A working "Match speakers" button inside Obsidian notes that contain the Unknown Speakers callout, calling the menubar app's HTTP bridge, updating the note in place, with graceful handling of daemon-not-running.

**Implements:**
- `registerMarkdownPostProcessor` detecting `.callout[data-callout="unknown-speakers"]`
- Button injected as a `MarkdownRenderChild` (lifecycle managed by Obsidian, auto-cleanup on re-render, idempotence guard)
- `registerDomEvent` for the click handler (not raw `addEventListener`)
- `requestUrl()` call to `http://127.0.0.1:<port>/label-speakers` with bearer token from plugin settings
- Tri-state button: idle → spinner ("Matching...") → check (success) / X + error text; button disabled while pending
- Graceful daemon-not-running: timeout + `ECONNREFUSED` → `new Notice("PlaudNoteTaker not reachable — is the app running?")` + inline error text
- Plugin settings tab: port field, test-connection button hitting `/health`
- `manifest.json` with correct `minAppVersion`

**Avoids:** Pitfall 8 (DOM leaks from missing `MarkdownRenderChild` wrapper, double-fire on re-render, `fetch()` vs `requestUrl()`).

**Research flag:** Live Preview mode quirk — `registerMarkdownPostProcessor` runs in Reading View only; Live Preview requires a separate `registerEditorExtension` (CodeMirror 6 extension). Determine at the start of this phase whether Live Preview support is required; if yes, budget a spike.

### Phase 5: Hardening + "Looks Done But Isn't" Checklist

**Rationale:** PITFALLS.md documents 15 "Looks Done But Isn't" items that appear complete but have missing critical pieces. This phase is a structured sweep before the milestone is declared done.

**Delivers:** A milestone that passes all verification criteria from PITFALLS.md; CLI confirmed unbroken.

**Key verification items:**
- Verify `@electron/rebuild` fires on fresh `npm install` and Eagle works in packaged app (not just dev)
- Verify notarization succeeds on a second clean Mac (not just the dev machine)
- Verify `powerMonitor` resume poll fires after real lid-close/open (not simulated)
- Verify HTTP bridge port is released within 5s of Cmd-Q during an in-flight request
- Verify Keychain Access.app shows "PlaudNoteTaker" entry name (not "Chromium Safe Storage")
- Verify exactly one "Match speakers" button per callout after editing note 5 times
- Verify migration sentinel prevents re-migration on second launch
- Verify Eagle profile byte preservation: speaker match results match pre-migration CLI output
- Verify CLI `plaud start` still works from terminal (no regressions from shared seam changes)
- Verify log stream contains no decrypted API key values

**Research flag:** No additional research needed; this is verification work against known criteria.

### Phase Ordering Rationale

- **Phase 0 before everything**: The config/log/dataDir seams are the integration points between CLI and app; any later divergence here breaks both simultaneously.
- **Eagle smoke test in Phase 1, not later**: If Eagle fails in Electron 41, every subsequent phase is built on the wrong Electron version. 20 lines of code, potentially saves days of debugging.
- **Signing/notarization in Phase 1**: Several table-stakes features (launch-at-login, Keychain-without-prompting, notification delivery) degrade or break in unsigned builds. Getting a signed build early means every subsequent phase can be tested realistically.
- **Migration before config before poll**: The startup sequence ordering constraint is a hard dependency chain — not a style preference.
- **HTTP bridge before Obsidian plugin**: Plugin development is blocked until the daemon exposes at least `POST /label-speakers` and `GET /health`.
- **Phase 5 as explicit sweep**: The "Looks Done But Isn't" items are the most common cause of "shipped but broken" Electron apps. A dedicated checklist phase prevents them from slipping.

### Research Flags

Phases needing deeper research or spikes during planning/execution:
- **Phase 1 (Eagle smoke test result):** If Eagle fails in Electron 41, fall back to Electron 40 immediately and document the constraint for future Electron upgrades.
- **Phase 3 (notification first-launch UX):** First-launch notification permission prompt behavior on macOS 14+ needs empirical verification on a signed build.
- **Phase 4 (Live Preview mode):** `registerMarkdownPostProcessor` is Reading View only. Determine whether the button must also appear in Live Preview — if yes, this requires a `registerEditorExtension` spike.

Phases with standard, well-documented patterns (skip additional research):
- **Phase 0**: Pure TypeScript refactor; no external APIs.
- **Phase 5**: Verification work against pre-defined criteria; no new patterns needed.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Direct source inspection of `node_modules/@picovoice/eagle-node` confirms N-API binary; Electron 41 docs verified; all other libraries verified via official docs + npm. One unverified assumption: Eagle in Electron 41 specifically (mandatory smoke test resolves this in Phase 1). |
| Features | HIGH | Electron menubar APIs (Tray, BrowserWindow, Notification, powerMonitor, safeStorage, setLoginItemSettings) are stable and well-documented. Obsidian plugin APIs (registerMarkdownPostProcessor, requestUrl, PluginSettingTab) verified against official docs. Anti-features grounded in PROJECT.md "Out of Scope". |
| Architecture | HIGH for component topology and IPC; MEDIUM for sleep/wake retry behavior | Service facade + 3 injection seams is well-trodden Electron pattern. Poll-loop-in-main-process is the right call for v1. Exact behavior of AssemblyAI requests across sleep/wake boundary needs empirical verification. |
| Pitfalls | HIGH for signing/notarization/entitlements/safeStorage; MEDIUM for SMAppService launch-at-login | Signing pitfalls verified against official Apple docs, Electron docs, and multiple corroborating bug trackers. SMAppService `macOS 13.6` launchd bug is documented but edge-case behavior is hard to pin without device testing. |

**Overall confidence:** HIGH — with the Eagle smoke test as the one mandatory gate before committing to Phase 1 direction.

### Gaps to Address

- **Eagle 3.0 in Electron 41 (unverified)**: Architecturally certain (N-API, single binary for all Node 18+ per `engines` field), but Picovoice has never published an Electron compatibility matrix. The 20-line smoke test in Phase 1 resolves this. If it fails in Electron 41, fall back to Electron 40 before any further work.
- **Obsidian Live Preview support for the "Match speakers" button**: `registerMarkdownPostProcessor` is Reading View only. Most users live in Live Preview (CodeMirror 6). Whether this needs a separate `registerEditorExtension` is a product question to resolve at the start of Phase 4.
- **notarytool round-trip timing**: First-time notarization can take 5–60 minutes and typically requires 2–3 iterations to get right. Phase 1 and Phase 3 estimates should include buffer for this.
- **`powerMonitor resume` fires twice on macOS** (documented `electron/electron#24803`): The poll loop's resume handler must debounce — this is a known quirk, not a gap, but it is easy to miss during implementation.

## Sources

### Primary (HIGH confidence)
- Direct source inspection — `node_modules/@picovoice/eagle-node/package.json`, `lib/mac/{arm64,x86_64}/pv_eagle.node` — confirms N-API prebuilt, single binary across Node 18+
- [Electron 41.0.0 release blog](https://www.electronjs.org/blog/electron-41-0) — Node 24.14, Chromium 146, ABI 145
- [Electron Forge: Why Electron Forge](https://www.electronforge.io/core-concepts/why-electron-forge) — first-party signing + notarization rationale
- [Electron Forge: Signing a macOS app](https://www.electronforge.io/guides/code-signing/code-signing-macos) — current macOS signing guide
- [Electron `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) + [electron/electron#45328](https://github.com/electron/electron/issues/45328) — pre-ready name bug documented
- [Electron `powerMonitor` API](https://www.electronjs.org/docs/latest/api/power-monitor) + [electron/electron#24803](https://github.com/electron/electron/issues/24803) — resume fires twice
- [Apple — Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) + [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Obsidian: Markdown post processing](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing) + [registerMarkdownPostProcessor reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerMarkdownPostProcessor)
- [Obsidian Forum: requestUrl vs fetch CORS](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)
- [Node-API docs](https://nodejs.org/api/n-api.html) — ABI stability guarantees across Node major versions
- `.planning/PROJECT.md` — authoritative scope and out-of-scope list
- `.planning/codebase/CONCERNS.md` — known tech debt; synchronous file I/O, ffmpeg, Eagle `console.warn`, AssemblyAI retry logic
- `.planning/codebase/ARCHITECTURE.md` — existing pipeline structure; all layers and data flows

### Secondary (MEDIUM confidence)
- [HTTPToolkit: Notarize with Forge](https://httptoolkit.com/blog/notarizing-electron-apps-with-electron-forge/) — practical walkthrough
- [Freek Van der Herten: replacing keytar with safeStorage](https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray) — migration pattern
- [microsoft/vscode#185677](https://github.com/microsoft/vscode/issues/185677) — VS Code keytar to safeStorage migration
- [theevilbit — SMAppService Quick Notes](https://theevilbit.github.io/posts/smappservice/) — macOS 13.6 launchd bug
- [Obsidian forum: Live Preview registerMarkdownPostProcessor caveat](https://forum.obsidian.md/t/registermarkdownpostprocessor-callback-not-called-with-live-preview-mode/56049)
- [Syncthing Status Icon (Obsidian plugin)](https://github.com/Diego-Viero/Syncthing-status-icon-Obsidian-plugin) — closest reference for localhost-daemon plugin pattern
- [menubar on npm](https://www.npmjs.com/package/menubar) — v9.5.2, Oct 2025
- Commit `8d0a17b` "Fix Eagle speaker profile serialization — use ArrayBuffer not Uint8Array" — prior-art gotcha in this codebase that must survive migration

### Tertiary (LOW confidence — needs validation during implementation)
- Eagle 3.0 `pv_eagle.node` loads in Electron 41 without rebuild — architecturally certain, empirically unverified. Resolve with Phase 1 smoke test before any further work.

---
*Research completed: 2026-04-16*
*Ready for roadmap: yes*
