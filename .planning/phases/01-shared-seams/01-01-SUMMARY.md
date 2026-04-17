---
phase: 01-shared-seams
plan: 01
subsystem: shared-seams
tags: [node16-esm, pub-sub, dotenv, dataDir, shim, loader-family]

# Dependency graph
requires:
  - phase: pre-phase
    provides: existing CLI + pipeline built on raw process.env / console / ./data
provides:
  - "src/config/ folder with Config type, required/optional helpers, loadConfigFromEnv"
  - "src/log/ folder with Set<Sink> pub/sub, consoleSink, auto-subscribe at import"
  - "src/state.ts SEAM comment documenting dataDir injection invariant"
  - "src/config.ts and src/log.ts shims preserving public import paths"
  - ".planning/phases/01-shared-seams/baselines/ pre+post CLI captures and empty diff-report.txt (SHAR-04 gate passed)"
affects: [02-scaffold-electron, pipeline, cli, future-app, phase-2-app-loader, phase-2-ipc-sink]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shim file pattern for Node16 ESM — src/module.ts re-exports from src/module/index.js so directory-internal organization is possible without breaking caller import paths."
    - "Set<Sink> pub/sub with swallowed sink errors — lightweight alternative to EventEmitter for a single-topic bus."
    - "Loader-family pattern — shared Config type in config/types.ts, source-specific loaders co-located in config/, barrel re-exports the active one as loadConfig."
    - "Module-load side effect for sink subscription — subscribe(consoleSink) at module scope in src/log/index.ts (not in init())."

key-files:
  created:
    - src/config/types.ts
    - src/config/validate.ts
    - src/config/env-loader.ts
    - src/config/index.ts
    - src/log/types.ts
    - src/log/core.ts
    - src/log/sink-console.ts
    - src/log/index.ts
    - .planning/phases/01-shared-seams/baselines/ (8 before + 8 after CLI captures, 16 exit-code sidecars, diff-report.txt)
  modified:
    - src/state.ts (SEAM header comment only — no signature changes)
    - src/config.ts (rewritten as 10-line shim)
    - src/log.ts (rewritten as 7-line shim)

key-decisions:
  - "Kept shim files src/config.ts and src/log.ts for Node16 ESM compatibility — directory imports (from \"./config\") fail at runtime under moduleResolution: Node16 + type: module. Shims preserve public import paths so zero caller files needed edits."
  - "No new npm dependencies — Set<Sink> (~30 LOC) chosen over EventEmitter / mitt / nanoevents; hand-rolled validate over zod; kept sync loadConfig + throw-on-missing."
  - "loadConfig stays sync and throws on missing env — preserved CLI contract. Phase 2 may revisit if Keychain access requires async."
  - "dotenv loaded inside loadConfigFromEnv() body (per plan) rather than at module scope — diverges from pre-refactor behavior where dotenv ran at module import. The dotenv informational \"tip:\" line (which rotates nondeterministically) is stripped in the SHAR-04 diff so parity remains binary."
  - "consoleSink subscribed at module scope in src/log/index.ts — not wrapped in init(). Phase 2's Electron main must additively subscribe(ipcSink); must NOT subscribe(consoleSink) a second time."

patterns-established:
  - "Shim + folder: every folder with multiple files has an explicit index.ts imported as ./folder/index.js; a same-named .ts shim file at the parent level preserves the public import path."
  - "Pub/sub via Set<Sink>: subscribe returns unsubscribe; emit swallows sink errors in try/catch; START captured at module load for elapsedMs."
  - "Loader family: shared Config type + family of loaders (env-loader now; app-loader in Phase 2); barrel aliases the active loader as loadConfig."
  - "Regression gate via strip+diff: timestamp prefix and nondeterministic library banner stripped; remaining diff must be zero bytes."

# Metrics
duration: 5min
completed: 2026-04-16
---

# Phase 1 Plan 1: Shared Seams Summary

**Three injection seams (dataDir documented, config split into loader-family, log replaced by Set<Sink> pub/sub) with byte-parity CLI shown by empty SHAR-04 diff — zero new npm deps, zero caller-file edits.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-17T03:11:02Z
- **Completed:** 2026-04-17T03:16:03Z
- **Tasks:** 3
- **Files modified:** 11 source files (3 modified + 8 created) + 33 baseline artifacts

## Accomplishments

- `src/config/` split into types / validate / env-loader / index. `process.env` now appears only in env-loader.ts (SHAR-02 unblock for Phase 2 app-loader).
- `src/log/` replaced single-file logger with `subscribe/emit` pub/sub + consoleSink. Legacy `log/warn/error` surface preserved via core.ts wrappers. Module-load `subscribe(consoleSink)` in index.ts keeps CLI output working with no init() call (SHAR-03).
- `src/state.ts` SEAM comment documents dataDir injection invariant; every exported function already took `dataDir: string` first (SHAR-01 — verification only, no signature changes).
- `src/config.ts` (10 lines) and `src/log.ts` (7 lines) reduced to shims; every existing caller imports `../config.js` / `../log.js` unchanged.
- SHAR-04 regression gate: 8 CLI commands captured pre+post, all 8 exit codes match, `diff-report.txt` is 0 bytes after stripping timestamp prefix and dotenv's nondeterministic tip banner. Compiled `node dist/index.js {--help,test}` also diffs clean against the tsx path.
- Zero new npm dependencies. package.json and package-lock.json unchanged across all three commits.

## Task Commits

Each task was committed atomically:

1. **Task 1: Capture baselines + state.ts SEAM + config split** — `de8ba9b` (refactor)
2. **Task 2: Split log into pub/sub + console sink + shim** — `d88423a` (refactor)
3. **Task 3: CLI regression diff + compiled dist verification (SHAR-04)** — `4a9e12e` (test)

## Files Created/Modified

### Created

- `src/config/types.ts` — `Config` interface (frozen, readonly fields, exact field set preserved from original).
- `src/config/validate.ts` — `required(raw, key)` and `optional(raw, key, fallback)` helpers; error message preserved verbatim ("Missing required environment variable: …. Run 'plaud init' to set up.").
- `src/config/env-loader.ts` — `loadConfigFromEnv(): Config`. Calls `loadDotenv({ path: envPath })` (no override, shell env wins). Returns frozen object.
- `src/config/index.ts` — Barrel: re-exports `Config`, `loadConfigFromEnv`, and aliases `loadConfigFromEnv as loadConfig`.
- `src/log/types.ts` — `LogLevel`, `LogEvent`, `Sink` type surface.
- `src/log/core.ts` — `const sinks = new Set<Sink>()`, `subscribe` (returns unsubscribe), `emit` (wraps each sink in try/catch), and legacy `log`/`warn`/`error` that call `emit`.
- `src/log/sink-console.ts` — `consoleSink` that preserves the `[HH:MM:SS +N.Ns]` prefix format byte-for-byte (en-US, hour12:false, 1-decimal elapsed seconds).
- `src/log/index.ts` — Barrel + module-scope `subscribe(consoleSink)` for CLI parity.
- `.planning/phases/01-shared-seams/baselines/plaud-before-*.txt` (8 files) + `.exitcode` sidecars (8 files)
- `.planning/phases/01-shared-seams/baselines/plaud-after-*.txt` (8 files) + `.exitcode` sidecars (8 files)
- `.planning/phases/01-shared-seams/baselines/diff-report.txt` — 0 bytes (SHAR-04 evidence)

### Modified

- `src/state.ts` — Added SEAM header comment documenting dataDir injection invariant. Zero code / signature changes.
- `src/config.ts` — Rewritten as 10-line shim: `export * from "./config/index.js"` + `export type { Config } from "./config/index.js"`.
- `src/log.ts` — Rewritten as 7-line shim: `export * from "./log/index.js"`.

## Decisions Made

- **Shim pattern for Node16 ESM.** Every top-level `src/X.ts` that became a folder keeps its file as a re-export shim. Rationale: under `moduleResolution: Node16 + "type": "module"`, directory imports fail at runtime with ERR_MODULE_NOT_FOUND. Shims preserve public import paths so no caller file needed editing.
- **`Set<Sink>` over EventEmitter.** ~30 LOC of Set<Sink> beats EventEmitter's topic-string API for a single-topic bus. No `mitt`/`nanoevents`/`pino`/`winston` — zero new deps.
- **`loadConfig()` stays sync + throws.** CLI contract (callers synchronously assume a value and throw on missing keys). Phase 2 may revisit when Keychain access forces async.
- **`consoleSink` subscribed at module scope, not via init().** Critical for CLI — `npx tsx src/index.ts start` must produce output without any init() call. Phase 2's Electron main adds subscribe(ipcSink) additively.
- **dotenv tip line stripped in regression diff.** dotenv prints a rotating "tip: …" banner that differs every run. It is library noise, not part of our output contract. The Task 3 strip function filters it out alongside timestamps so the gate is binary (see Deviations below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug in plan's regression-diff script] dotenv "tip:" banner is nondeterministic; stripped in the diff**

- **Found during:** Task 1 smoke test (noticed dotenv prints `◇ injected env (11) from .env // tip: ⌘ …` differently on each run)
- **Issue:** The plan's strip function only stripped the `[HH:MM:SS +N.Ns]` timestamp prefix. It did not account for dotenv's rotating tip banner, which differs between runs (e.g. `tip: ⌘ override existing` on one run, `tip: ⌘ multiple files { path: [...] }` on another). Two sequential pre-refactor runs would already produce a non-empty diff under the plan's script — meaning the gate was flaky before any refactor change.
- **Additional second-order effect:** the original `src/config.ts` loaded dotenv at module scope (side effect on every import, even `--help`), while the plan's prescribed `env-loader.ts` puts `loadDotenv` inside `loadConfigFromEnv()` body. This changes WHERE the tip line appears in the output stream (e.g. appears after "ffmpeg: OK" instead of at the top). Since the tip line is already library noise, stripping it also absorbs this ordering shift.
- **Fix:** Extended the strip function in Task 3 PART C to also delete any line matching `^◇ injected env ([0-9]+) from \.env`. This preserves the plan's prescribed env-loader structure (dotenv inside the function body) while keeping the SHAR-04 gate binary.
- **Files modified:** None in source tree — the fix lives only in the shell strip function in the Task 3 workflow. No source behavior was altered.
- **Verification:** `diff-report.txt` is 0 bytes across all 8 command pairs; all 8 exit codes match; `node dist/index.js --help` and `node dist/index.js test` diff clean against the tsx path. Shell env override still works (`VAULT_NOTES_FOLDER=ShellOverrideFixture` value appears in the output as "Fallback folder: ShellOverrideFixture").
- **Committed in:** `4a9e12e` (Task 3 commit, as the generated `diff-report.txt`'s zero-byte state)

**2. [Rule 1 — Baseline integrity] Used fixed fixture path for `label /nonexistent` from the start**

- **Found during:** Task 1 baseline capture (before writing any before-baseline command)
- **Issue:** The plan's Task 1 Part A captured `label /nonexistent-$(date +%s).md` (timestamp-suffixed), then Task 3 had a stash/unstash dance to regenerate the before-file with a fixed path. A stash round-trip during execution is risky (could accidentally touch index state) and unnecessary.
- **Fix:** Captured the before-baseline with `label /nonexistent-label-fixture.md` (the same fixed fixture Task 3 requires) from the start. No stash dance needed.
- **Files modified:** `.planning/phases/01-shared-seams/baselines/plaud-before-label-nonexistent.txt` (captured with fixed fixture on first try)
- **Verification:** Baseline integrity preserved; `diff-report.txt` shows this pair diffs clean.
- **Committed in:** `de8ba9b` (Task 1 commit)

**3. [Rule 1 — Baseline integrity] Used fixed VAULT_NOTES_FOLDER value in shell-override baseline**

- **Found during:** Task 1 baseline capture
- **Issue:** The plan captured `VAULT_NOTES_FOLDER=ShellOverride_$(date +%s)` (timestamp-suffixed) in the before, then `ShellOverride_postrefactor` in the after. These two strings differ, so the value appears differently in output and would create spurious diff churn. The plan's own note acknowledges this ("If the ONLY diff … is the literal shell-override value … Re-run both with a single fixed string").
- **Fix:** Used `VAULT_NOTES_FOLDER=ShellOverrideFixture` in both before and after captures so the string literally matches.
- **Files modified:** `.planning/phases/01-shared-seams/baselines/plaud-before-shell-override.txt`, `plaud-after-shell-override.txt`
- **Verification:** Shell-override pair diffs to 0 bytes after stripping; shell override semantics still verified (the value appears in output, proving dotenv did not override it).
- **Committed in:** `de8ba9b` (before) and `4a9e12e` (after)

---

**Total deviations:** 3 auto-fixed (all Rule 1 — making the regression gate actually binary; zero source-behavior changes).
**Impact on plan:** All three deviations were fixes to the plan's verification mechanism, not to the refactor itself. The seams, shims, pub/sub, auto-subscribe, and caller-unchanged invariants were all implemented exactly as specified. The SHAR-04 gate is now a clean 0-byte diff across 8 command pairs + compiled dist.

## Issues Encountered

- None during planned work. The dotenv tip-line discovery (above) was handled under Rule 1 and did not require any source-level change.

## User Setup Required

None — no external service configuration required. This phase is pure internal refactor.

## Next Phase Readiness

**Ready for Phase 2 (Scaffold Electron):**

- Seams are in place and verified via CLI parity: Phase 2 can add `src/config/app-loader.ts` next to `env-loader.ts` and `src/log/sink-ipc.ts` next to `sink-console.ts` with zero changes to `src/pipeline.ts`, `src/cli/*`, `src/plaud/*`, `src/transcription/*`, `src/summarization/*`, `src/notes/*`, `src/speakers/*`, `src/state.ts`, or `src/audio.ts`.
- `process.env` reads are isolated to `src/config/env-loader.ts` — confirmed by `grep -rn "process\.env" src/` returning exactly one match. Phase 2's Keychain-backed app-loader can replace `process.env` with `safeStorage` output without touching any other file.
- `dataDir` is already threaded via function parameters throughout state.ts; Phase 2 can pass Electron's `userData` dir in place of `./data` with no signature changes.

**Gotchas for Phase 2:**

- **Do NOT call `subscribe(consoleSink)` again in Electron main.** It is already subscribed at module load via `src/log/index.ts`. Electron main should subscribe additively: `subscribe(ipcSink)` only. Sinks compose.
- **Phase 2's app-loader should live as `src/config/app-loader.ts`** (co-located with env-loader.ts) so the barrel `src/config/index.ts` can expose both. The public `loadConfig()` alias is intentionally parameterless this phase; Phase 2 may break it to `loadConfig(source: 'env' | 'app')` or switch the barrel's default alias based on a runtime flag — plan for that breaking change at Phase 2 start.
- **Shim + Node16 ESM landmine:** every new folder under `src/` needs an explicit `index.ts` imported as `./folder/index.js`. A same-named `.ts` shim at the parent level (e.g. `src/foo.ts` re-exporting `./foo/index.js`) preserves the public import path. Do NOT `import { x } from "./folder"` without `.js` — it type-checks but fails at runtime.
- **`subscribe(consoleSink)` in `src/log/index.ts` runs exactly once** because ESM caches modules. Safe even if Phase 2 imports the log barrel from multiple files in the main process.
- **Sink errors are swallowed in `emit()`.** Phase 2's IPC sink may throw transiently (before the BrowserWindow exists, during shutdown, on disconnect). Those throws will NOT break consoleSink or any other sink. By design.

**Blockers/concerns:**

- None introduced by this phase.
- Pre-existing Phase 2 concern still applies: Eagle native module in Electron 41 is architecturally certain but empirically unverified (SCAF-03 smoke test resolves).

---
*Phase: 01-shared-seams*
*Completed: 2026-04-16*
