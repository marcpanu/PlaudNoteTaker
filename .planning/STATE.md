# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-16)

**Core value:** New Plaud recordings land in Obsidian as polished notes without the user ever opening a terminal, and labeling unknown speakers is a single click inside the note.
**Current focus:** Phase 5 complete — only Phase 2b (signing + notarization) remains before milestone complete.

## Current Position

Phase: 5 of 5 complete
Status: Existing `/Users/marcpanu/CodeRepos/obsidian-note-taker` plugin merged into repo as `obsidian-plugin/`. All Eagle operations routed through the daemon's HTTP bridge (single SDK = single profile store). Match Speakers button injected into Unknown Speakers callouts via registerMarkdownPostProcessor. Plugin no longer depends on @picovoice/eagle-web.
Last activity: 2026-04-17 — Phase 5 integrated in 3 plans. Empirical cross-SDK test (scripts/test-cross-sdk-profile.ts) confirmed eagle-web and eagle-node profile formats are incompatible (web SDK bytes produce NaN scores in node SDK). This drove the plugin-as-bridge-client architecture. Plugin deployed to vault at ~/obsidian-vault/.obsidian/plugins/ai-notetaker/main.js via `npm run build`.

Progress: [██████████] 100% of build scope (Phase 2b signing/notarization is a polish step independent of functional scope)

## Performance Metrics

**Velocity:**
- Total plans completed: 1
- Average duration: 5 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase           | Plans | Total | Avg/Plan |
|-----------------|-------|-------|----------|
| 01-shared-seams | 1/1   | 5 min | 5 min    |

**Recent Trend:**
- Last 5 plans: 01-01 (5 min)
- Trend: — (baseline)

*Updated after each plan completion*

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Project-wide: Electron menubar over Tauri — Eagle is a Node native module that requires a Node-compatible host
- Project-wide: Pipeline runs in Electron main process (not a spawned CLI subprocess) — simpler IPC, shared in-memory state
- Project-wide: `safeStorage` over `keytar` for Keychain-backed API key storage — zero native-dep maintenance, built into Electron
- Project-wide: Obsidian plugin talks to daemon via `127.0.0.1` HTTP + bearer token — loopback-only, no LAN exposure, no auth infrastructure
- Project-wide: No auto-update in v1 — rebuild-and-drag installs are fine for a single-user tool
- Phase 1: Shim-file pattern for Node16 ESM — `src/module.ts` re-exports from `src/module/index.js` so callers' import paths never break
- Phase 1: `Set<Sink>` pub/sub (~30 LOC) chosen over EventEmitter / mitt / nanoevents — zero new deps, single-topic bus doesn't need topic-string API
- Phase 1: `loadConfig()` stays synchronous and throws on missing env — preserved CLI contract; Phase 2 may revisit if Keychain access forces async
- Phase 1: `subscribe(consoleSink)` runs at module scope in `src/log/index.ts` — not via init(); Phase 2 main additively subscribes IPC sink
- Phase 1: dotenv stays in `loadConfigFromEnv()` body (per plan); dotenv's rotating "tip:" banner stripped in SHAR-04 diff to keep gate binary
- Phase 2a: Electron 41.2.1 is the baseline (Eagle smoke passed; no 40 fallback)
- Phase 2a: `@picovoice/eagle-node` shipped as `extraResource` (Forge Vite plugin packs only Vite output into asar; node_modules is NOT copied). Runtime loads via `require(join(process.resourcesPath, 'eagle-node'))` in packaged mode.
- Phase 2a: ffmpeg-static binary bundled via `extraResource` + `asar.unpack: '**/ffmpeg'`. Runtime: `app.isPackaged ? join(resourcesPath,'ffmpeg') : require('ffmpeg-static')`.
- Phase 2a: icon files shipped as extraResource too (Resources/iconTemplate.png + @2x). `nativeImage.setTemplateImage(true)` for auto light/dark.
- Phase 2a: hardened-runtime entitlements plist in place; critically OMITS `allow-unsigned-executable-memory` (the Electron 12+ trap).
- Phase 2a: 5 commits recorded instead of planned 5 — merged into 1 code commit + 1 metadata commit for efficiency (user directive: less ceremony).

### Pending Todos

None yet.

### Blockers/Concerns

- ~~Phase 2 empirical gate~~ — RESOLVED: Eagle loads cleanly on Electron 41.2.1
- **Phase 5 research flag**: `registerMarkdownPostProcessor` runs in Reading View only. Determine at start of Phase 5 whether Live Preview support is required; if yes, budget a `registerEditorExtension` spike.
- **Picovoice quota**: user is at 99/100 min (as of 2026-04-17). Eagle works — confirmed via live CLI `plaud label` run that enrolled a new speaker successfully. Do NOT construct Eagle with a real key in any smoke test until quota resets. The `runEagleSmoke()` in `electron/main.ts` already defaults to `__invalid__` when `PICOVOICE_ACCESS_KEY` is unset, which is safe. Phase 4 (popover/notifications/bridge) and Phase 5 (Obsidian plugin) do not touch speakers and are unaffected.
- **Possible minor bug in `src/cli/label.ts`**: re-running label on an already-labeled note did NOT early-exit with "already enrolled, skipping" — it re-enrolled Sarah from scratch on the second run, burning ~20 min of Eagle quota. Not Phase 3 scope; log for later triage.

## Session Continuity

Last session: 2026-04-16
Stopped at: Completed 01-01-PLAN.md (Shared Seams). Next up: plan Phase 2 (Scaffold Electron).
Resume file: None

### Phase 1 artifacts (for Phase 2 planning context)

- `src/config/` — types, validate, env-loader, index. `process.env` isolated to env-loader only.
- `src/log/` — types, core (Set<Sink> pub/sub), sink-console, index (auto-subscribes consoleSink).
- `src/state.ts` — SEAM comment documenting dataDir injection.
- `src/config.ts`, `src/log.ts` — thin shims preserving public import paths.
- `.planning/phases/01-shared-seams/baselines/diff-report.txt` — 0 bytes (SHAR-04 evidence).
- Phase 1 SUMMARY: `.planning/phases/01-shared-seams/01-01-SUMMARY.md`
