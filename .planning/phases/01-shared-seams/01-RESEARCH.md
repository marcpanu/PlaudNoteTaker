# Phase 1: Shared Seams - Research

**Researched:** 2026-04-16
**Domain:** TypeScript refactor — introducing three injection seams (config split, log pub/sub, dataDir parameter) in an existing ESM/Node16 CLI codebase without behavioral regression.
**Confidence:** HIGH

---

## Summary

Phase 1 is a **structural refactor**, not a feature phase. The job is to convert three existing modules (`src/config.ts`, `src/log.ts`, `src/state.ts`) into shapes that a future Electron app in Phase 2 can consume without any forking of pipeline code. The CLI's observable behavior — exit codes, stdout/stderr, side effects, `.env` loading — must not change. A prior architectural pass (`.planning/research/ARCHITECTURE.md`) has already settled the *what*; this research settles the *how* with concrete TypeScript signatures, file layouts, and a verification strategy.

The standard approach for this class of refactor is mechanical: (1) move the existing implementation into a new file, (2) keep the old path as a one-line re-export shim, (3) add new entry points alongside the shim, (4) thread new parameters through callers one-by-one. No new runtime libraries are needed — the codebase already has `dotenv` (env loader), Node's built-in `fs`/`path` (state I/O), and `console` (the sole log sink for now). Even the pub/sub logger is ~30 lines of vanilla TS using a `Set<Sink>`; no library is warranted.

The one non-obvious landmine is **Node16 ESM directory imports**. Folder imports like `import { x } from "./config"` work at TypeScript type-check time but **fail at Node runtime** — ESM requires an explicit file (e.g. `./config/index.js`). The existing `src/config.ts` and `src/log.ts` must therefore stay as physical files (as re-export shims) rather than be converted to folders-with-index — otherwise every caller across `src/cli/*.ts`, `src/pipeline.ts`, and `src/transcription/assemblyai.ts` breaks. This is consistent with the prior ARCHITECTURE.md sketch.

**Primary recommendation:** Keep `src/config.ts`, `src/log.ts`, `src/state.ts` as the **public module paths** callers import from. Behind them, create folders (`src/config/`, `src/log/`) whose files the shim re-exports. Change `state.ts` function signatures to take `dataDir` as an explicit first parameter — no `StateCtx` wrapper object. Verify with a `plaud test` smoke run + a manual checklist captured in the plan; no new test framework this phase.

---

## Standard Stack

This phase adds **zero** new runtime dependencies. Everything is already in the tree.

### Core (already installed)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `dotenv` | ^17.4.2 | Load `.env` for the CLI config loader | Already used; 2026 mainstream for Node CLIs; project's canonical env source |
| Node built-ins | Node 22+ / Electron 41's Node 24.14 | `fs`, `path` for state I/O; `console` for log sink | No external logging lib justified for a single-sink console logger |
| `typescript` | ^6.0.2 | Type-check the refactor | Already configured with `strict: true`, `module: "Node16"` |

### Supporting (no new installs)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsx` | ^4.21.0 (dev) | Run the CLI without building (`npx tsx src/index.ts`) | Already used for development and verification |

### Alternatives Considered (and rejected for this phase)
| Instead of | Could Use | Why Rejected |
|------------|-----------|--------------|
| Custom `Set<Sink>` pub/sub (~30 LOC) | Node `EventEmitter` | `EventEmitter` adds a topic-string API we don't need; we have exactly one topic ("log events"). Straight set-of-functions is fewer lines, no memory-leak warnings, no name typos. |
| Custom `Set<Sink>` pub/sub | `pino`, `winston`, `bunyan`, `electron-log` | All of these are logging frameworks. We already have a working minimal logger; replacing it now is scope creep. `electron-log` may be revisited in Phase 2 if the IPC sink wants rotation/persistence for free, but **not this phase**. |
| Zod-validated `Config` | Hand-rolled `required()`/`optional()` | Existing loader uses hand-rolled validation; Zod is a larger refactor with runtime cost. Keep the existing validation style and just extract it to a shared function both loaders call. Revisit zod if/when Phase 2 adds the Keychain loader and validation diverges. |
| `StateCtx` object threading | Explicit `dataDir: string` param | `dataDir` is the only thing threaded. A single-field object is a premature abstraction. If Phase 2 needs more, change the signature then. |
| Folders `src/config/` + `src/log/` replacing files | Folder-only, no shim file | **Breaks Node16 ESM runtime** — directory imports are not resolved. Shim files (or writing `from "./config/index.js"` everywhere) are the only options; shim is less churn. |

**Installation:** *(none)*

```bash
# No npm install step this phase.
```

---

## Architecture Patterns

### Recommended Project Structure (after Phase 1)

```
src/
├── index.ts                        # UNCHANGED
├── config.ts                       # SHIM: re-exports from ./config/index.js
├── log.ts                          # SHIM: re-exports from ./log/index.js
├── pipeline.ts                     # UNCHANGED (still imports from ./config.js, ./log.js)
├── state.ts                        # MODIFIED: all exported fns now take dataDir as first arg (already do; verify)
├── audio.ts                        # UNCHANGED
│
├── config/                         # NEW
│   ├── index.ts                    # Barrel: re-exports Config, loadConfig, loadConfigFromEnv
│   ├── types.ts                    # `Config` type (extracted from current config.ts)
│   ├── validate.ts                 # required()/optional() helpers, shared validation
│   └── env-loader.ts               # loadConfigFromEnv(): reads .env via dotenv, returns Config
│                                   # NOTE: NO app-loader.ts this phase. Phase 2 adds it.
│
├── log/                            # NEW
│   ├── index.ts                    # Barrel: re-exports types, subscribe, emit, log/warn/error, consoleSink
│   ├── types.ts                    # LogEvent, LogLevel, Sink types
│   ├── core.ts                     # emit(), subscribe() pub/sub; legacy log()/warn()/error()
│   └── sink-console.ts             # consoleSink: the current timestamped console behavior
│
├── cli/                            # UNCHANGED (no import changes needed because shims preserve paths)
├── plaud/                          # UNCHANGED
├── transcription/                  # UNCHANGED (still imports from "../log.js")
├── summarization/                  # UNCHANGED
├── speakers/                       # UNCHANGED (profiles.ts already takes dataDir)
└── notes/                          # UNCHANGED
```

**Why shim files matter (Node16 ESM constraint — HIGH confidence, see Sources):**
TypeScript's `moduleResolution: Node16` + `package.json "type": "module"` means relative imports are resolved by Node's ESM rules, which **do not support directory imports**. `import { X } from "./config"` fails at runtime even if it type-checks. Therefore:
- `src/config.ts` must remain as a file that re-exports from `./config/index.js`.
- `src/log.ts` must remain as a file that re-exports from `./log/index.js`.
- No caller needs to change their import path (`from "../config.js"`, `from "./log.js"` stay as-is).

### Pattern 1: Two Loaders, One Type (Config)

**What:** Extract the `Config` interface into `config/types.ts`. Move the current env-reading logic into `config/env-loader.ts` as `loadConfigFromEnv()`. Extract `required()` and `optional()` into `config/validate.ts` so they're reusable when Phase 2 adds an app loader. The public `loadConfig()` (exported from `config/index.ts` and re-exported by the `config.ts` shim) wraps `loadConfigFromEnv()` for now — Phase 2 can switch on a source argument.

**When to use:** From commit 1 of this phase; it's the joint where CLI and app will diverge.

**Trade-offs:**
- Pro: Zero import-path changes in existing callers. `loadConfig()` still exists.
- Pro: Phase 2's app-loader (Keychain + JSON) drops in next to `env-loader.ts` with no changes to pipeline/CLI.
- Con: One extra indirection level (`config.ts` → `config/index.ts` → `config/env-loader.ts`). Trivial.

**Contract (prescriptive — use these exact shapes):**

```typescript
// src/config/types.ts
// Source: current src/config.ts lines 25-38 (transcribe the object shape verbatim)

export interface Config {
  readonly plaudBearerToken: string;
  readonly assemblyAiApiKey: string;
  readonly geminiApiKey: string;
  readonly geminiModel: string;
  readonly picovoiceAccessKey: string;          // "" when not configured (current behavior)
  readonly vaultPath: string;
  readonly vaultNotesFolder: string;
  readonly templatesPath: string;                // "" when not configured (current behavior)
  readonly selectedTemplate: string;
  readonly pollInterval: number;                 // milliseconds, already parsed
  readonly dataDir: string;                      // absolute, already resolved
}
```

```typescript
// src/config/validate.ts
// Extract these from current src/config.ts lines 11-21 unchanged.

export function required(raw: Record<string, string | undefined>, key: string): string {
  const value = raw[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Run 'plaud init' to set up.`);
  }
  return value;
}

export function optional(raw: Record<string, string | undefined>, key: string, fallback: string): string {
  return raw[key] || fallback;
}
```

```typescript
// src/config/env-loader.ts
import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import type { Config } from "./types.js";
import { required, optional } from "./validate.js";

/**
 * Load Config from environment variables (CLI path).
 * Side effect: loads .env into process.env if a .env file exists in cwd.
 * Behavior preserved from original src/config.ts (throws on missing required keys).
 */
export function loadConfigFromEnv(): Config {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }

  const e = process.env;
  return Object.freeze({
    plaudBearerToken: required(e, "PLAUD_BEARER_TOKEN"),
    assemblyAiApiKey: required(e, "ASSEMBLYAI_API_KEY"),
    geminiApiKey: required(e, "GEMINI_API_KEY"),
    geminiModel: optional(e, "GEMINI_MODEL", "gemini-2.5-flash"),
    picovoiceAccessKey: optional(e, "PICOVOICE_ACCESS_KEY", ""),
    vaultPath: required(e, "VAULT_PATH"),
    vaultNotesFolder: optional(e, "VAULT_NOTES_FOLDER", "Meeting Notes"),
    templatesPath: optional(e, "TEMPLATES_PATH", ""),
    selectedTemplate: optional(e, "SELECTED_TEMPLATE", "Default"),
    pollInterval: parseInt(optional(e, "POLL_INTERVAL", "60"), 10) * 1000,
    dataDir: resolve(optional(e, "DATA_DIR", "./data")),
  });
}
```

```typescript
// src/config/index.ts
export type { Config } from "./types.js";
export { loadConfigFromEnv } from "./env-loader.js";

/**
 * Public loader. For this phase, always reads from env.
 * Phase 2 will add: loadConfig(source: 'env' | 'app') — do not pre-empt the signature now.
 */
export { loadConfigFromEnv as loadConfig } from "./env-loader.js";
```

```typescript
// src/config.ts   ← SHIM file, ~2 lines
export * from "./config/index.js";
export type { Config } from "./config/index.js";
```

**Error-handling discipline — DO NOT introduce `Result<Config, Error>`.** The existing code throws on missing required vars; every caller already expects this (see `runTest` catch at `src/cli/test.ts:22-27`). Changing to a result type is a semantic change the CLI regression will not catch. Keep throwing.

### Pattern 2: Pub/Sub Logger (Set-of-Sinks, ~30 LOC)

**What:** A single module-level `Set<Sink>` where sinks are `(ev: LogEvent) => void`. `emit()` iterates the set. The public `log()` / `warn()` / `error()` functions that pipeline code currently calls are preserved verbatim and internally call `emit()`. The console sink is subscribed once at import time to preserve CLI behavior immediately.

**When to use:** From commit 1 of this phase.

**Trade-offs:**
- Pro: Pipeline code (`src/pipeline.ts`, `src/transcription/assemblyai.ts`, `src/cli/start.ts`) doesn't change at all — still calls `log()`, `warn()`, `error()`.
- Pro: Phase 2 can `subscribe(ipcSink)` in `app/main.ts` with zero changes to core.
- Pro: No dependency added.
- Con: If a sink throws, it must be caught so it doesn't break the emit loop. (See pitfall below.)

**Contract:**

```typescript
// src/log/types.ts

export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  readonly level: LogLevel;
  readonly message: string;            // pre-formatted primary message
  readonly args: readonly unknown[];   // extra args passed to log(...args) after the first
  readonly ts: number;                 // Date.now() at emit time
  readonly elapsedMs: number;          // ms since module import (process startup proxy)
}

export type Sink = (ev: LogEvent) => void;
```

```typescript
// src/log/core.ts
import type { LogEvent, LogLevel, Sink } from "./types.js";

const START = Date.now();
const sinks = new Set<Sink>();

/** Subscribe a sink. Returns an unsubscribe function. */
export function subscribe(sink: Sink): () => void {
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

/** Emit a log event to all subscribed sinks. Sink errors are swallowed to protect the caller. */
export function emit(level: LogLevel, args: unknown[]): void {
  const first = args[0];
  const message = typeof first === "string" ? first : String(first);
  const rest = args.slice(1);
  const ev: LogEvent = {
    level,
    message,
    args: rest,
    ts: Date.now(),
    elapsedMs: Date.now() - START,
  };
  for (const sink of sinks) {
    try { sink(ev); } catch { /* never let a bad sink break emit */ }
  }
}

// Legacy surface — same signatures as the original src/log.ts.
// All existing `import { log, warn, error } from "../log.js"` keep working verbatim.
export function log(...args: unknown[]): void   { emit("info",  args); }
export function warn(...args: unknown[]): void  { emit("warn",  args); }
export function error(...args: unknown[]): void { emit("error", args); }
```

```typescript
// src/log/sink-console.ts
// Reproduces the exact formatting of the original src/log.ts verbatim.
import type { LogEvent, Sink } from "./types.js";

function formatTimestamp(ev: LogEvent): string {
  const elapsed = (ev.elapsedMs / 1000).toFixed(1);
  const now = new Date(ev.ts).toLocaleTimeString("en-US", { hour12: false });
  return `[${now} +${elapsed}s]`;
}

export const consoleSink: Sink = (ev) => {
  const prefix = formatTimestamp(ev);
  const out = [prefix, ev.message, ...ev.args];
  switch (ev.level) {
    case "info":  console.log(...out); break;
    case "warn":  console.warn(...out); break;
    case "error": console.error(...out); break;
  }
};
```

```typescript
// src/log/index.ts
import { subscribe } from "./core.js";
import { consoleSink } from "./sink-console.js";

// Auto-subscribe the console sink at module load. CRITICAL for CLI behavior parity.
// Without this, `npx tsx src/index.ts start` would produce no output.
subscribe(consoleSink);

export type { LogEvent, LogLevel, Sink } from "./types.js";
export { subscribe, emit, log, warn, error } from "./core.js";
export { consoleSink } from "./sink-console.js";
```

```typescript
// src/log.ts   ← SHIM file
export * from "./log/index.js";
```

**Output-parity note (CRITICAL):** The original `src/log.ts` does:
```
console.log(timestamp(), ...args);
```
where `timestamp()` returns a single formatted string. The new consoleSink must produce **byte-identical** output for the CLI regression to pass. The reconstruction above preserves:
- Prefix shape: `[HH:MM:SS +N.Ns]` (24-hour, en-US locale)
- Arg splatting: extra args passed through to `console.*` unchanged (so `log("msg", obj)` still pretty-prints `obj`)
- Level routing: info→`console.log`, warn→`console.warn`, error→`console.error`

### Pattern 3: dataDir as Explicit First Parameter (state.ts)

**What:** Every exported function in `state.ts` takes `dataDir: string` as its first argument. The module never reads `config.dataDir`. Callers pass `config.dataDir` explicitly at every call site.

**When to use:** Always. This is seam SHAR-01.

**Status check — already partially done:** Reading `src/state.ts` as of this phase: **every exported function already takes `dataDir` as its first parameter.** (`loadProcessedIds(dataDir)`, `saveProcessedId(dataDir, id)`, `saveRecordingMeta(dataDir, ...)`, `getRecordingMeta(dataDir, ...)`, `addToHistory(dataDir, ...)`, `getRecentHistory(dataDir, ...)`). The only remaining seam work is **verification** — grep `state.ts` for any `config.` reference (there are none currently) and codify the invariant in a comment.

**Recommendation:** No signature changes needed in `state.ts` itself. Add a header comment documenting the invariant:

```typescript
// src/state.ts (top of file, after imports)

/**
 * SEAM: dataDir injection (SHAR-01).
 * All exported functions accept `dataDir` as their first parameter.
 * This module MUST NOT import Config or read config.dataDir.
 * Callers (CLI handlers, pipeline) thread the resolved path from loadConfig().dataDir.
 */
```

Callers (unchanged — already correct):
- `src/pipeline.ts:59, 140` — passes `config.dataDir` ✓
- `src/cli/start.ts:55, 74, 76, 88, 105, 110` — passes `config.dataDir` ✓
- `src/cli/label.ts:52, 74, 121` — passes `config.dataDir` ✓
- `src/cli/speakers.ts:6, 23, 35` — passes `config.dataDir` ✓
- `src/speakers/profiles.ts` already takes `dataDir` parameter ✓

**No `StateCtx` wrapper.** Rejected: single-field objects are premature abstraction. If Phase 2 needs to thread more context, change then.

### Anti-Patterns to Avoid

- **Directory imports (`from "./config"`).** Broken at runtime under Node16 ESM. Always use `./file.js` or keep a shim file.
- **Introducing `Result<Config, Error>` or similar.** Not needed — existing throw-on-missing behavior is battle-tested by `plaud test`. Changes the CLI contract.
- **Using `EventEmitter` for the logger.** Adds a topic-name API nobody needs; easy to typo an event name and never realize. `Set<Sink>` is 30 LOC and can't typo.
- **Making the loader async (`async function loadConfig()`).** `dotenv` is sync; every current caller is sync. Changing the return to `Promise<Config>` would cascade `await` into every entry point. Keep sync for this phase.
- **Renaming `log()`/`warn()`/`error()` in the rewrite.** Pipeline code imports these by name. Preserve exactly.
- **Reading `process.env` outside `config/env-loader.ts`.** After this refactor, the invariant "only the env-loader reads `process.env`" is what makes Phase 2's app-loader swap clean. Search the codebase to confirm: currently zero `process.env` reads outside `config.ts` (verified via grep).
- **Eagerly exporting a `Source: 'env' | 'app'` discriminator in the `loadConfig` signature this phase.** The app source doesn't exist yet. YAGNI. Phase 2 adds the parameter when there's an actual second loader.

---

## Don't Hand-Roll

This phase is unusual because the instruction is largely the *opposite*: **keep hand-rolled** what is already hand-rolled. Introducing a library now would block the CLI regression path.

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Loading `.env` | Custom `fs.readFileSync` + parser | Keep existing `dotenv` | Already in deps; proven |
| Timestamped log prefix | A new date library | Keep existing `Date.now()` / `toLocaleTimeString("en-US")` | The whole sink is ~10 LOC |
| Pub/sub bus | `pubsub-js`, `mitt`, `nanoevents`, Node `EventEmitter` | `Set<Sink>` (this phase only) | One topic, 30 LOC, no npm install |
| JSON state read/write | A database, `lowdb`, `electron-store` | Keep existing `readFileSync`/`writeFileSync` in state.ts | Out of scope — async rewrite is tracked in CONCERNS.md for a later phase |
| Config validation | `zod`, `joi`, `ajv` | Keep existing `required()`/`optional()` helpers | Same validation behavior; zero new deps; zod can be considered in Phase 2 if the app loader's validation shape diverges |

**Key insight:** The whole point of this phase is **shaping seams**, not **changing technology**. Every library added here becomes a thing Phase 2 inherits. Keep the surface area small; the restructure itself is the work.

---

## Common Pitfalls

### Pitfall 1: Directory Imports Silently Compile But Fail at Runtime

**What goes wrong:** Creating `src/config/index.ts` and writing `import { loadConfig } from "./config"` (no extension, no `/index.js`) — TypeScript's language server shows no error, but `npx tsx src/index.ts start` throws `ERR_MODULE_NOT_FOUND` at runtime.

**Why it happens:** `tsconfig.json` has `moduleResolution: "Node16"` and `package.json` has `"type": "module"`. Node's ESM resolution does **not** do directory lookups — it requires an explicit filename. TypeScript's `Node16` mode enforces `.js` extensions in imports but has a long-standing gap where `./foo` can type-check as resolving to `./foo/index.ts` even though it won't run.

**How to avoid:**
1. Preserve `src/config.ts` and `src/log.ts` as shim files.
2. For any new cross-folder import, always use `"./path/file.js"` (note the `.js` even in `.ts` source — this is the ESM TypeScript idiom already used everywhere in the codebase).
3. After the refactor, run `npx tsx src/index.ts test` — if the shims are missing or an import is a directory import, this fails at module-load time before any API call.

**Warning signs:** An import with no file extension or ending in a folder name. An error like `Cannot find module '/Users/.../src/config' imported from '/Users/.../src/cli/start.js'`.

### Pitfall 2: Breaking CLI stdout Format with the New Logger

**What goes wrong:** Refactoring `log()` to emit a structured object and having the console sink reformat it with slightly different spacing, different locale, different elapsed-time precision. `plaud start` output looks "the same" to a human but breaks any downstream scripts or expectations.

**Why it happens:** The original `src/log.ts` builds a single timestamp string and passes it as the first arg to `console.log`. A rewrite that, say, uses `console.log(level.toUpperCase(), prefix, message)` would reorder fields.

**How to avoid:**
- Copy the original `timestamp()` function verbatim into `consoleSink`.
- Keep the call shape `console.log(prefix, message, ...rest)` — matches what every existing `log("foo", obj)` expects.
- Test with a side-by-side `diff` of `plaud start` output before/after refactor (see CLI regression strategy below).

**Warning signs:** A `log()` call passing multiple arguments (e.g. `log("  Recognized speakers:", matches)`) produces output that no longer includes the second arg in the correct position.

### Pitfall 3: The Console Sink Is Subscribed Twice (Or Zero Times)

**What goes wrong:** `subscribe(consoleSink)` lives in `src/log/index.ts`. If another module also subscribes it, every log line prints twice. If the subscribe statement is accidentally inside a function that's never called, nothing prints.

**Why it happens:** The module-level side effect "subscribe on import" is slightly unusual. Someone reviewing the code may "helpfully" move the call into an `initLogging()` function that the CLI forgets to call.

**How to avoid:**
- Put `subscribe(consoleSink)` at module scope in `src/log/index.ts` (runs exactly once on first import).
- Add a comment: `// Auto-subscribed at module load — required for CLI stdout parity.`
- Do NOT export an `initLogging()` or equivalent; there is no "init" step.
- Phase 2's Electron main process will do its own `subscribe(ipcSink)` additionally — that's additive and safe.

**Warning signs:** Duplicate lines in `plaud test` output; or silence instead of expected output.

### Pitfall 4: dotenv Overwrites Already-Set Env Vars (Or Fails to)

**What goes wrong:** A user sets `VAULT_PATH=/tmp/a` in their shell and also has `VAULT_PATH=/tmp/b` in `.env`. Old behavior: `dotenv.config()` does **not** override already-set variables by default (this is `dotenv`'s standard). New loader must preserve this precedence, or users' shell overrides silently stop working.

**Why it happens:** `dotenv` has an `override: true` option. If anyone adds it "for consistency" in the refactor, shell env wins becomes `.env` wins. Changes the CLI contract.

**How to avoid:**
- In `env-loader.ts`, call `loadDotenv({ path: envPath })` with **no `override` option** (same as current `src/config.ts`). dotenv's default is `override: false`.
- Verify via the regression checklist: run `VAULT_PATH=/tmp/shell-value npx tsx src/index.ts test` and confirm the vault path message says `/tmp/shell-value`, not whatever `.env` has.

**Warning signs:** Shell env vars no longer override `.env` after the refactor.

### Pitfall 5: Freezing Config Mid-Refactor Breaks a Caller

**What goes wrong:** The new loader uses `Object.freeze(...)` (recommended for the seam — enforces "Config is immutable after load"). But some existing code might mutate config somewhere — e.g. normalizing `vaultPath` lazily. `Object.freeze` silently does nothing in non-strict mode and *throws* in strict mode (which this project has via TS `strict: true`, though that's compile-time, not runtime strict). A runtime throw breaks things.

**Why it happens:** ESM modules run in strict mode by default. Assignment to a frozen property throws `TypeError`.

**How to avoid:**
- Before freezing, grep the codebase for any assignment to `config.*`:
  ```
  grep -rn "config\.\w\+\s*=" src/
  ```
- If the grep is empty (it currently is — verified), `Object.freeze` is safe. If it's not, either leave the object unfrozen (still fine for the seam) or convert the mutating code to take a value instead of mutating config.

**Warning signs:** A runtime `TypeError: Cannot assign to read only property` after the refactor.

### Pitfall 6: Running `tsx` From the Wrong Working Directory Changes `.env` Resolution

**What goes wrong:** The CLI regression checklist is run from a different `cwd` than the original test. `resolve(process.cwd(), ".env")` finds no file, `required()` throws, exit code is 1 — but the tester thinks the refactor broke config loading.

**Why it happens:** The existing loader uses `process.cwd()`. Any refactor that changes this (e.g. to `__dirname`-relative) changes behavior.

**How to avoid:** Keep `resolve(process.cwd(), ".env")` verbatim. Run all regression tests from the project root.

**Warning signs:** "Missing required environment variable" errors in the regression that didn't exist before, often fixed by `cd`-ing to the project root.

---

## Code Examples

All examples are verified against the current codebase and the TypeScript `moduleResolution: Node16` constraint.

### Example 1: The `config.ts` Shim File

```typescript
// src/config.ts
// SHIM: preserves the public import path `./config.js` for all existing callers.
// Do not add logic here — it belongs in ./config/env-loader.ts or ./config/validate.ts.

export * from "./config/index.js";
export type { Config } from "./config/index.js";
```

### Example 2: The `log.ts` Shim File

```typescript
// src/log.ts
// SHIM: preserves the public import path `./log.js`.

export * from "./log/index.js";
```

### Example 3: End-to-end Call Flow (Unchanged From Caller's View)

```typescript
// src/cli/start.ts  — NO CHANGES NEEDED after this phase

import { loadConfig } from "../config.js";   // resolves to config.ts shim → config/index.ts → env-loader.ts
import { log, warn, error } from "../log.js"; // resolves to log.ts shim → log/index.ts
import { loadProcessedIds } from "../state.js"; // unchanged; already takes dataDir

export async function runStart(): Promise<void> {
  const config = loadConfig();              // still sync, still throws on missing vars
  log("PlaudNoteTaker starting...");        // still prints `[14:32:15 +0.1s] PlaudNoteTaker starting...`
  const ids = loadProcessedIds(config.dataDir);
  // ... rest unchanged
}
```

### Example 4: Phase 2 Preview (NOT THIS PHASE — For Reference Only)

Shows the extensibility the seams provide. Nothing in this snippet is built in Phase 1.

```typescript
// src/app/main.ts (Phase 2)
import { subscribe } from "../log/index.js";
import { consoleSink } from "../log/index.js";
import { loadConfigFromApp } from "../config/app-loader.js"; // added in Phase 2
import { ipcSink } from "./log-ipc-sink.js";                 // added in Phase 2

subscribe(consoleSink);
subscribe(ipcSink(/* BrowserWindows */));

const config = await loadConfigFromApp({ /* ctx */ });        // different source, same Config type
const dataDir = resolveDataDir("app");                         // different default, same string
// createService({ config, dataDir })  ← same pipeline functions
```

The planner does **not** implement any of this in Phase 1. It's shown so the planner can see the shape the refactor is aiming at.

---

## CLI Regression Strategy (the completion gate for this phase)

This is the verification gate for SHAR-04. The user's plan explicitly says "don't over-engineer" — **do not add a Vitest/Jest setup this phase.** Use a manual checklist run from a clean shell, captured in the plan's verification steps.

### Recommended approach: manual smoke checklist, run before and after each refactor step

The planner should turn the following into explicit verification tasks in the phase's PLAN.md:

**Setup (one-time, before starting):**
1. Ensure a working `.env` exists and `plaud test` currently passes.
2. Capture a baseline:
   ```
   npx tsx src/index.ts test 2>&1 | tee /tmp/plaud-before-test.txt
   npx tsx src/index.ts --help 2>&1 | tee /tmp/plaud-before-help.txt
   npx tsx src/index.ts speakers list 2>&1 | tee /tmp/plaud-before-speakers.txt
   ```
3. (Optional, if a test recording is available and safe-to-process) capture baseline of one `start` iteration output.

**After the refactor (gate):**

A. Commands that must behave identically (exit code + stdout/stderr structure):

| Command | What to verify |
|---------|----------------|
| `npx tsx src/index.ts` (no args) | Prints USAGE; exit 0 |
| `npx tsx src/index.ts --help` | Prints USAGE; exit 0 |
| `npx tsx src/index.ts unknown-cmd` | Prints "Unknown command: ..."; exit 1 |
| `npx tsx src/index.ts test` | Same set of lines, same order, same checkmarks. Timestamps differ — that's fine. Exit 0 (or 1 if config missing — same as before). |
| `npx tsx src/index.ts speakers list` | Same output as baseline; exit 0. |
| `npx tsx src/index.ts speakers delete NonexistentName` | `Speaker "NonexistentName" not found.` + exit 1. |
| `npx tsx src/index.ts label` (no arg) | `Usage: plaud label <note-file>` + exit 1. |
| `npx tsx src/index.ts label /nonexistent.md` | `Note file not found: ...` + exit 1. |

B. Behavior: shell env vars still override `.env`:
```
VAULT_NOTES_FOLDER=FromShell npx tsx src/index.ts test | grep "Fallback folder: FromShell"
```
Must show `FromShell`, not the `.env` value.

C. Behavior: missing `.env` with no shell vars must still throw the original error:
```
cd /tmp && npx tsx /absolute/path/src/index.ts test 2>&1 | grep "Missing required environment variable"
```

D. (Optional / if safe) one full `plaud start` tick:
```
timeout 120 npx tsx src/index.ts start 2>&1 | head -50
```
Compare line-by-line (ignoring timestamps with `sed 's/\[.*\]//'`) against baseline.

**Diff tool for the checklist:**
```bash
diff <(sed 's/\[[^]]*\] *//' /tmp/plaud-before-test.txt) \
     <(sed 's/\[[^]]*\] *//' /tmp/plaud-after-test.txt)
```
Expected: empty diff.

### What NOT to do

- **Do not add a test framework** (Vitest, Jest, Mocha). None is configured today; bootstrapping one is a separate concern and is out of scope.
- **Do not add a CI check.** The user's style is manual verification.
- **Do not try to automate visual output comparison beyond the diff above.** Timestamps will differ; elapsed times will differ. Strip with sed, compare the rest.

### Decision: single verification task or per-seam?

**Recommendation:** A single "CLI regression" verification task at the end of the plan, run once after all three seams are restructured. Rationale:
- The seams are intertwined (config is imported by every CLI, log is imported by most, state is imported by three). Running the checklist after each partial change inflates work.
- A single run at the end catches interaction bugs better.
- If the checklist fails, bisect by reverting one seam's changes at a time.

An alternative is to run the smoke set after each of the three structural changes. That's safer but more expensive. For a small codebase with known callers, once-at-the-end is the right trade.

---

## Minimum Viable Diff (MVD) — "What's the LEAST restructuring?"

The user explicitly said "don't over-engineer." Here is the **minimum** diff that satisfies SHAR-01..04:

### Files CREATED (7 new files)

| File | LOC estimate | Purpose |
|------|--------------|---------|
| `src/config/types.ts` | ~15 | `Config` interface (extracted) |
| `src/config/validate.ts` | ~12 | `required()`, `optional()` helpers |
| `src/config/env-loader.ts` | ~30 | `loadConfigFromEnv()` |
| `src/config/index.ts` | ~5 | Barrel |
| `src/log/types.ts` | ~15 | `LogEvent`, `LogLevel`, `Sink` |
| `src/log/core.ts` | ~35 | `emit`, `subscribe`, `log`/`warn`/`error` |
| `src/log/sink-console.ts` | ~20 | `consoleSink` |
| `src/log/index.ts` | ~10 | Barrel + auto-subscribe |

**Total new code:** ~140 LOC of mostly mechanical extraction.

### Files MODIFIED (2 files)

| File | Change | LOC diff |
|------|--------|----------|
| `src/config.ts` | Replace content with re-export shim | -40 +2 |
| `src/log.ts` | Replace content with re-export shim | -18 +1 |
| `src/state.ts` | Add SEAM comment at top (NO signature changes — already correct) | +7 |

### Files UNCHANGED

- `src/index.ts` — no import changes
- `src/pipeline.ts` — no import changes
- All `src/cli/*.ts` — no import changes
- All `src/plaud/*.ts`, `src/transcription/*.ts`, `src/summarization/*.ts`, `src/speakers/*.ts`, `src/notes/*.ts` — no import changes
- `src/audio.ts` — no changes
- `package.json` — no new deps
- `tsconfig.json` — no changes

### What is deliberately DEFERRED to Phase 2 (do not build now)

- `src/config/app-loader.ts` (Keychain + JSON reading) — app source doesn't exist
- A `source: 'env' | 'app'` discriminator in `loadConfig()` — no second loader yet
- IPC / batched log sinks — no Electron main process yet
- `src/app/paths.ts` / `resolveDataDir()` — CLI's resolution is the only resolution path this phase
- Any async rewrite of `state.ts` — tracked in `CONCERNS.md`, explicitly out of scope
- Any `StateCtx` or `AppCtx` type — premature abstraction; add when a second field appears

### Task ordering recommendation for the planner

Because the seams are independent but all three converge in `src/cli/*` callers, serialize:

1. **Seam: state.ts (SHAR-01).** Lowest risk — mostly documentation. Verify with `plaud speakers list` (exercises `state.ts`-adjacent `profiles.ts`).
2. **Seam: config split (SHAR-02).** Extract types/validate/env-loader; write shim. Verify with `plaud test`.
3. **Seam: log pub/sub (SHAR-03).** Extract types/core/sink-console; write shim; auto-subscribe. Verify with `plaud test` (stdout must match baseline after `sed`-stripping timestamps).
4. **CLI regression gate (SHAR-04).** Run the full checklist against baseline captures.

---

## State of the Art

| Old Approach (pre-Phase 1) | New Approach (post-Phase 1) | When Changed | Impact |
|----------------------------|----------------------------|--------------|--------|
| `src/config.ts` is a single file doing env read + validation + type export | Same *public* file (now a shim), but split internally into types/validate/env-loader | This phase | Unblocks Phase 2 adding a second loader |
| `src/log.ts` writes directly to `console.log/warn/error` | Same file (now a shim), routes through a `Set<Sink>` pub/sub; console is one sink | This phase | Unblocks Phase 2 adding an IPC sink |
| `src/state.ts` takes `dataDir` parameter (already correct) | Same — now documented with a SEAM invariant comment | This phase | Enforces the contract explicitly |

**Deprecated/outdated:** None. This phase does not deprecate any API. The legacy `log()`, `warn()`, `error()`, `loadConfig()`, `Config` surface is preserved exactly.

---

## Open Questions

1. **Should `loadConfig()` accept an optional `source?: 'env'` discriminator now, or only in Phase 2?**
   - What we know: The architecture research shows the eventual shape (`loadConfig(source, ctx?)` returning `Promise<Config>`).
   - What's unclear: Whether adding the optional arg now (defaulting to `'env'`) saves churn later.
   - Recommendation: **Do not add it now.** Adding an optional arg that must be ignored for the entire phase duration is speculative. Phase 2 should revisit the signature — it may also become async for the Keychain call, which would be a breaking change anyway.

2. **Should the CLI shell script (`npm start` = `node dist/index.js start`) be verified too, or only `npx tsx src/index.ts`?**
   - What we know: The phase description mentions `npx tsx src/index.ts {init,start,label,speakers,test}` specifically.
   - What's unclear: Whether the compiled `dist/` path is also considered "CLI behavior."
   - Recommendation: Verify both paths. Add `npm run build` + `node dist/index.js test` to the checklist. The shim files in particular could have subtle `.js` extension mismatches that only show up after compilation.

3. **Should `src/state.ts` get a SEAM comment *and* a typed re-export interface, or just the comment?**
   - What we know: The file already satisfies SHAR-01 structurally.
   - What's unclear: Whether Phase 2 will want `state.ts` to expose a `StateStore` interface.
   - Recommendation: **Just the comment this phase.** An interface with one method per function adds surface area with no current consumer. Revisit if Phase 2 needs to mock state in tests.

4. **Should we delete the `templatesPath` empty-string-default and use `undefined` instead?**
   - What we know: Current code uses `""` to mean "not configured" for `picovoiceAccessKey` and `templatesPath`. Callers check with `if (config.picovoiceAccessKey)` and `if (!config.templatesPath)`.
   - What's unclear: `undefined` is arguably more idiomatic.
   - Recommendation: **Keep `""`.** Changing it is a semantic shift that could ripple (several falsy checks). Not this phase.

---

## Sources

### Primary (HIGH confidence)

- **TypeScript Handbook — Modules Reference** ([typescriptlang.org/docs/handbook/modules/reference.html](https://www.typescriptlang.org/docs/handbook/modules/reference.html)) — directly confirms that under `moduleResolution: node16`, ESM `import` statements do **not** support directory imports. Explicit filenames (`.js`) are required. This is the central runtime constraint that shapes the shim-file recommendation.
- **In-repo `src/config.ts`, `src/log.ts`, `src/state.ts`, `src/cli/*.ts`, `src/pipeline.ts`** — authoritative source of current behavior, call patterns, and invariants to preserve.
- **In-repo `.planning/research/ARCHITECTURE.md`** — prior architectural pass. This research refines Pattern 1 (Service Facade), Pattern 2 (Pub/Sub Logger), Pattern 3 (Config by Provenance), and Pattern 4 (Data Dir Injected Once) into concrete Phase-1 signatures. All recommendations here are consistent with that document.
- **In-repo `.planning/codebase/CONVENTIONS.md`** — canonical style (ESM `.js` extensions, named exports only, no barrel files currently — this phase deliberately introduces per-module `index.ts` barrels inside the new `config/` and `log/` folders because they are Node-resolvable files, not directory imports).
- **In-repo `package.json`, `tsconfig.json`** — confirm `"type": "module"`, `moduleResolution: "Node16"`, `strict: true`, and the absence of any test framework.

### Secondary (MEDIUM confidence)

- **dotenv README ([npm — dotenv](https://www.npmjs.com/package/dotenv))** — `override: false` is the default; existing loader relies on this. Verified via WebSearch summary.
- **Stack Overflow / TypeScript issue #61057 — directory resolution gap** ([github.com/microsoft/TypeScript/issues/61057](https://github.com/microsoft/TypeScript/issues/61057)) — confirms TypeScript sometimes *does* resolve directory imports for type-checking that *do not* run in Node ESM. Strengthens the "keep shim files" recommendation.

### Tertiary (LOW confidence)

- **Various pub/sub pattern articles from WebSearch** (Medium, DigitalOcean, strictmode.io) — informed the "Set<Sink> over EventEmitter" decision for a single-topic logger. LOW confidence because no official Node.js source prescribes one over the other; this is a taste call informed by LOC and surface area.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new libraries, all decisions reference existing deps and architecture research.
- Architecture (file layout, shim pattern): HIGH — Node16 ESM directory-import constraint is documented in TypeScript's own handbook.
- Config loader contract: HIGH — transcribed from existing `src/config.ts` behavior.
- Log pub/sub contract: HIGH — design matches the prior ARCHITECTURE.md recommendation verbatim; output-parity rules confirmed by reading the existing `log.ts`.
- dataDir seam: HIGH — grepped the codebase; `state.ts` functions already take `dataDir`; callers already pass `config.dataDir`; no signature changes needed.
- Pitfalls: HIGH for pitfalls 1, 4, 6 (codebase-verified); MEDIUM for 2, 3, 5 (reasoning from code + standard patterns).
- CLI regression strategy: HIGH — the checklist exercises the exact commands named in SHAR-04; matches the project's existing manual-test style.

**Research date:** 2026-04-16
**Valid until:** 2026-07-16 (90 days; this is structural refactor territory on a stable codebase — no fast-moving ecosystem concerns)
