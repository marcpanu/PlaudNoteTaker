# Architecture Research

**Domain:** Electron menubar wrapper around an existing Node/TypeScript CLI pipeline, with an Obsidian plugin as a remote trigger over loopback HTTP
**Researched:** 2026-04-16
**Confidence:** HIGH for component topology, IPC, and config/log/data-dir evolution (Electron docs are current and well-trodden). MEDIUM for poll-loop placement (main vs utilityProcess) — genuine tradeoff, called out explicitly. MEDIUM for sleep/wake semantics (documented API, but exact Plaud/AssemblyAI retry behavior after resume needs empirical check in the relevant phase).

---

## Guiding Principles

Before the diagrams, five principles that drive the rest of this document:

1. **The pipeline is the product. Electron is a shell.** `src/pipeline.ts` and its dependencies must not learn that Electron exists. All coupling happens in a thin adapter layer.
2. **One process owns the pipeline at a time.** Either the CLI process owns it (when user runs `plaud start` in a terminal) or the Electron main process owns it. Never both simultaneously against the same data dir. Enforced by a pidfile lock in the data dir.
3. **Renderers are views, not actors.** Renderers never call pipeline modules directly. They dispatch intents via IPC; main executes; main broadcasts results.
4. **The Obsidian plugin is a keyboard shortcut, not a subsystem.** It posts to loopback HTTP; the HTTP handler is a thin wrapper around the same service methods IPC uses. No plugin-specific business logic.
5. **Thin abstractions only.** Three injection seams (`config`, `log`, `dataDir`) and one service facade. That's it. No DI container, no event bus framework, no plugin architecture.

---

## Standard Architecture

### System Overview

```
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │                            macOS host (single user)                              │
 │                                                                                  │
 │  ┌────────────────────────┐       ┌────────────────────────────────────────────┐ │
 │  │  Obsidian (Electron)   │       │      PlaudNoteTaker.app (Electron)         │ │
 │  │                        │       │                                            │ │
 │  │  ┌──────────────────┐  │ HTTP  │  ┌──────────────────────────────────────┐  │ │
 │  │  │ Plaud Plugin     │──┼───────┼─▶│   HTTP Bridge  127.0.0.1:<port>      │  │ │
 │  │  │ (TS plugin code) │  │ POST  │  │   (Fastify/Express in MAIN)          │  │ │
 │  │  └──────────────────┘  │       │  └──────────────┬───────────────────────┘  │ │
 │  └────────────────────────┘       │                 │ calls service facade     │ │
 │                                   │                 ▼                          │ │
 │  ┌────────────────────────┐ IPC   │  ┌──────────────────────────────────────┐  │ │
 │  │  Popover (renderer)    │◀──────┼─▶│   Service Facade  (src/app/svc.ts)   │  │ │
 │  │  Settings (renderer)   │ cBrg  │  │   • processNow()                     │  │ │
 │  │  Logs (renderer)       │       │  │   • labelNote(path)                  │  │ │
 │  └────────────────────────┘       │  │   • listSpeakers() / deleteSpeaker() │  │ │
 │                                   │  │   • testConnections()                │  │ │
 │                                   │  │   • getStatus() / getHistory()       │  │ │
 │                                   │  └──────┬───────────────────────────────┘  │ │
 │                                   │         │ thin calls                       │ │
 │                                   │         ▼                                  │ │
 │                                   │  ┌──────────────────────────────────────┐  │ │
 │                                   │  │   Existing core  (src/*)             │  │ │
 │                                   │  │   pipeline.ts  plaud/  transcription/│  │ │
 │                                   │  │   summarization/  speakers/  notes/  │  │ │
 │                                   │  │   audio.ts  state.ts                 │  │ │
 │                                   │  │   (UNCHANGED except 3 inject seams)  │  │ │
 │                                   │  └──────┬───────────────────────────────┘  │ │
 │                                   │         │                                  │ │
 │                                   │   ┌─────┴──────┬────────────┬──────────┐   │ │
 │                                   │   ▼            ▼            ▼          ▼   │ │
 │                                   │ ┌──────┐  ┌─────────┐  ┌────────┐  ┌─────┐ │ │
 │                                   │ │Poll  │  │ Keychain│  │ Data   │  │ ~/  │ │ │
 │                                   │ │Loop  │  │(safeStor│  │ dir    │  │Obs  │ │ │
 │                                   │ │(main │  │ age)    │  │JSON    │  │vault│ │ │
 │                                   │ │timer)│  │         │  │files   │  │(md) │ │ │
 │                                   │ └──────┘  └─────────┘  └────────┘  └─────┘ │ │
 │                                   └────────────────────────────────────────────┘ │
 │                                                                                  │
 │  ┌────────────────────────┐                                                      │
 │  │  Terminal: `plaud …`   │  Alternate entrypoint — same src/*, same data dir,   │
 │  │  (existing CLI)        │  via pidfile-coordinated mutual exclusion with app.  │
 │  └────────────────────────┘                                                      │
 └──────────────────────────────────────────────────────────────────────────────────┘
                 │                                  │                     │
                 ▼                                  ▼                     ▼
        ┌──────────────┐                    ┌──────────────┐      ┌──────────────┐
        │ Plaud cloud  │                    │ AssemblyAI   │      │ Gemini       │
        └──────────────┘                    └──────────────┘      └──────────────┘
                                                   (Picovoice Eagle runs in-process, no cloud)
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| **Main process** | Own pipeline lifecycle, timers, HTTP, Keychain, data dir. Single source of truth. | Electron main; TypeScript; imports `src/app/*` and `src/*` |
| **Poll loop** | Drive periodic `pipeline.processNew()`. Reentrancy-locked. Pauses on sleep, resumes on wake. | `setTimeout` chain inside main (not `setInterval`). See tradeoff below. |
| **Service facade** (`src/app/svc.ts`) | Single entry surface used by IPC handlers AND HTTP handlers. Enforces the reentrancy lock. | Thin TS module; each method is one await away from an existing `src/*` function |
| **HTTP bridge** (`src/app/http.ts`) | 127.0.0.1 server; token-auth; maps HTTP verbs to `svc.*` calls | Fastify (or Node `http`); bound to `127.0.0.1`; ephemeral port persisted to data dir |
| **IPC handlers** (`src/app/ipc.ts`) | Register `ipcMain.handle('svc:*')` channels; each handler delegates to `svc` | `ipcMain.handle`; typed via shared TS interface |
| **Preload script** (`src/app/preload.ts`) | `contextBridge.exposeInMainWorld('plaud', {...})`; expose typed svc surface + event subscriptions to renderers | Context-isolated; no Node in renderer |
| **Popover renderer** | Status, recent notes, "Process now" button, recent log tail | Electron `BrowserWindow` or `Tray`-anchored panel; React or plain TS |
| **Settings renderer** | API keys (read/write via IPC → Keychain), vault path, poll interval, template | Electron `BrowserWindow`; modal-ish |
| **Logs renderer** | Live stream of log events from main | Electron `BrowserWindow`; append-only virtualized list |
| **Keychain service** (`src/app/secrets.ts`) | Read/write API keys via Electron `safeStorage` → Keychain | `safeStorage.encryptString` + file, or direct `keytar`. See tradeoff. |
| **Config module** (evolved `src/config.ts`) | Return a `Config` object from either `.env` (CLI) or Keychain+settings.json (app) | Two loaders, one `Config` type; pipeline sees only the type |
| **Log module** (evolved `src/log.ts`) | Emit structured log events; sinks are console (CLI) and IPC broadcast (app) | Pub/sub within one process; sinks registered at startup |
| **Data dir module** (`src/app/paths.ts`, new) | Resolve data dir once at startup; pass into `state.ts` constructors | Env override → app.getPath('userData') → `./data/` fallback |
| **Obsidian plugin** | "Process now" command, "Label current note" command, health indicator in status bar | Obsidian plugin; `requestUrl` to `127.0.0.1:<port>`; stores token in plugin settings |

---

## Recommended Project Structure

```
src/
├── index.ts                       # CLI dispatcher (UNCHANGED)
├── config.ts                      # Now a thin re-export of config/loader.ts
├── log.ts                         # Now a thin re-export of log/core.ts
├── pipeline.ts                    # UNCHANGED
├── state.ts                       # MODIFIED: accepts dataDir in constructor/factory
├── audio.ts                       # UNCHANGED
│
├── cli/                           # UNCHANGED (init, start, label, test, speakers)
│
├── plaud/                         # UNCHANGED
├── transcription/                 # UNCHANGED
├── summarization/                 # UNCHANGED
├── speakers/                      # UNCHANGED
├── notes/                         # UNCHANGED
│
├── config/                        # NEW: split config loaders behind single Config type
│   ├── types.ts                   # `Config` interface (unchanged shape)
│   ├── loader-env.ts              # Reads .env via dotenv (CLI path)
│   ├── loader-app.ts              # Reads Keychain + settings.json (app path)
│   └── index.ts                   # loadConfig(source: 'env' | 'app')
│
├── log/                           # NEW: pub/sub logger with pluggable sinks
│   ├── core.ts                    # emit(event), subscribe(fn), legacy log()/warn()/error()
│   ├── sink-console.ts            # The current behavior, for CLI
│   └── types.ts                   # LogEvent = { level, message, ts, elapsed, context? }
│
└── app/                           # NEW: Electron-only glue (never imported by CLI)
    ├── main.ts                    # Electron app entry; ffmpeg check → migrate → unlock → svc start
    ├── preload.ts                 # contextBridge.exposeInMainWorld('plaud', {...})
    ├── ipc.ts                     # ipcMain.handle('svc:*', ...) registration
    ├── http.ts                    # 127.0.0.1 Fastify server; routes → svc
    ├── svc.ts                     # Service facade — THE single mutation surface
    ├── poll.ts                    # Timer loop; pause/resume on powerMonitor
    ├── lock.ts                    # Pidfile mutual-exclusion with CLI
    ├── paths.ts                   # resolveDataDir() + migration
    ├── secrets.ts                 # safeStorage / Keychain wrapper
    ├── migrate.ts                 # First-run .env → Keychain, ./data/ → userData/
    ├── tray.ts                    # Tray icon, menu, popover window
    ├── windows.ts                 # BrowserWindow factories (popover, settings, logs)
    └── renderer/
        ├── popover/               # html + ts
        ├── settings/
        └── logs/
```

### Structure Rationale

- **`src/app/` is the only new top-level folder.** Everything Electron-specific lives here. Deleting `src/app/` must leave a working CLI. This is the single most important structural invariant.
- **`config/` and `log/` become folders, not files.** The existing `src/config.ts` and `src/log.ts` become one-line re-exports for back-compat so no other `src/*` file has to change its imports.
- **`state.ts` stays in place** but gains a `dataDir` parameter threaded through from `src/app/paths.ts` (in the app) or from `~/.plaud` / `./data` (in the CLI). Every other module that touches state goes through `state.ts`, so this is the only file that needs the dataDir injected.
- **No `src/services/`, no `src/core/`.** The pipeline already has a clean domain layering. Adding another layer to "make room for Electron" would hide the actual work. The service facade is a single file because its job is dispatch, not logic.
- **Preload and renderers live inside `src/app/renderer/`** so they share tsconfig and build pipeline with the rest. An `electron-vite` or `electron-forge` setup can target these with a separate tsconfig that sets `lib: ["DOM"]`; the main process tsconfig stays Node-only.

---

## Architectural Patterns

### Pattern 1: Service Facade (the ONE new abstraction)

**What:** Every operation the app or plugin can trigger is a method on `svc`. IPC and HTTP are transport shells around the same method set. Reentrancy/locking lives here, not in transports.

**When to use:** Always. There is exactly one path from transport → pipeline.

**Trade-offs:**
- Pro: Transport-agnostic; testing `svc` tests everything without booting Electron.
- Pro: Lock is in one place. No race between an IPC "process now" and an HTTP "process now".
- Con: Mild indirection; trivial compared to what it buys.

**Example:**
```typescript
// src/app/svc.ts
import { PlaudClient } from '../plaud/client';
import { processRecording } from '../pipeline';
import { loadProcessed } from '../state';
import { emit } from '../log/core';

class ReentrancyLock {
  private busy = false;
  async run<T>(label: string, fn: () => Promise<T>): Promise<T | { skipped: true }> {
    if (this.busy) { emit({ level: 'info', message: `skipped ${label} (busy)` }); return { skipped: true }; }
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
}

export function createService(deps: { config: Config; dataDir: string }) {
  const lock = new ReentrancyLock();
  const plaud = new PlaudClient(deps.config);
  return {
    processNow: () => lock.run('process', () => processNewRecordings(plaud, deps)),
    labelNote:  (path: string) => lock.run('label', () => runLabel(path, deps)),
    listSpeakers: () => listSpeakerProfiles(deps.dataDir),
    deleteSpeaker: (name: string) => deleteSpeakerProfile(name, deps.dataDir),
    testConnections: () => testAll(deps.config),
    getStatus: () => ({ busy: lock.busy, lastPoll: /* ... */ }),
    getHistory: () => loadHistory(deps.dataDir),
  };
}
export type Service = ReturnType<typeof createService>;
```

IPC and HTTP both import `Service` and do nothing but adapt arguments and shape responses.

### Pattern 2: Pub/Sub Logger with Pluggable Sinks

**What:** `src/log/core.ts` keeps an in-memory subscriber list. CLI registers the console sink. The app registers console + an IPC-broadcast sink. Existing `log()`/`warn()`/`error()` call signatures are preserved; they now `emit()` internally.

**When to use:** From day one of this milestone. Logs to renderers are the user-visible value of "status updates".

**Trade-offs:**
- Pro: Pipeline code doesn't change at all — still calls `log()`.
- Pro: Backpressure-safe because sinks are sync dispatchers that optionally buffer.
- Con: Slight risk of log storms flooding IPC. Mitigation: the renderer sink batches with `requestIdleCallback`-equivalent (a 50ms coalescer).

**Example:**
```typescript
// src/log/core.ts
type Sink = (ev: LogEvent) => void;
const sinks = new Set<Sink>();
export function subscribe(s: Sink) { sinks.add(s); return () => sinks.delete(s); }
export function emit(ev: Omit<LogEvent, 'ts' | 'elapsed'>) {
  const full = { ...ev, ts: Date.now(), elapsed: Date.now() - START };
  for (const s of sinks) try { s(full); } catch {}
}
export const log   = (m: string) => emit({ level: 'info',  message: m });
export const warn  = (m: string) => emit({ level: 'warn',  message: m });
export const error = (m: string) => emit({ level: 'error', message: m });
```

```typescript
// src/app/main.ts  (fragment)
subscribe(consoleSink);
subscribe(batchedIpcSink(BrowserWindow.getAllWindows));
```

### Pattern 3: Config by Provenance (same type, two loaders)

**What:** A single `Config` type. Two loaders: `loadConfigFromEnv()` for CLI, `loadConfigFromApp()` for Electron (reads Keychain + `settings.json`). The pipeline only sees `Config`.

**When to use:** From the first commit of this milestone. It's the joint where CLI and app diverge.

**Trade-offs:**
- Pro: Zero changes in any `src/*` consumer.
- Pro: Clear mental model — "where do secrets live?" answered by one file.
- Con: Duplicate validation logic. Mitigated by extracting `validate(raw) → Config` into `config/validate.ts` and calling from both loaders.

**Example:**
```typescript
// src/config/index.ts
export async function loadConfig(source: 'env' | 'app', ctx?: AppCtx): Promise<Config> {
  const raw = source === 'env' ? readEnv() : await readAppSources(ctx!);
  return validate(raw);
}
```

### Pattern 4: Data Dir Injected Once, at the Top

**What:** Exactly one call to `resolveDataDir()` at process start. The resolved string is passed into `createService({ dataDir, ... })` and flows into every `state.ts` call as a parameter. No module ever re-resolves the path.

**When to use:** Always. This is the second joint where CLI and app must agree.

**Trade-offs:**
- Pro: No hidden globals; tests can point at a tmp dir.
- Con: `state.ts` functions grow a `dataDir` parameter. One-time API change. Acceptable.

**Resolution order (same in CLI and app, different defaults):**
```typescript
// src/app/paths.ts
export function resolveDataDir(mode: 'cli' | 'app'): string {
  if (process.env.PLAUD_DATA_DIR) return process.env.PLAUD_DATA_DIR;       // 1. explicit override
  if (mode === 'app') return path.join(app.getPath('userData'), 'data');   // 2. app default
  return path.resolve(process.cwd(), 'data');                              // 3. CLI default (back-compat)
}
```

Migration on first app launch: if app default is empty but `./data/` at CWD exists, copy (not move) it once, write a `.migrated` marker.

### Pattern 5: Poll Loop as Self-Rescheduling Timer

**What:** Not `setInterval`. A function that runs, awaits completion, then `setTimeout`s its next invocation. Paused via a boolean set by `powerMonitor` suspend/resume.

**When to use:** For any I/O-driven periodic task where overrun is possible (and Plaud API polling absolutely can overrun on slow transcription).

**Trade-offs:**
- Pro: Guarantees no concurrent overlap (also guarded by the svc lock as belt-and-suspenders).
- Pro: Easy to pause/resume.
- Con: Must remember to reschedule in `finally`.

**Example:**
```typescript
// src/app/poll.ts
let paused = false, timer: NodeJS.Timeout | null = null, stopped = false;
export function startPoll(svc: Service, intervalMs: number) {
  const tick = async () => {
    if (stopped) return;
    if (!paused) { try { await svc.processNow(); } catch (e) { emit({ level: 'error', message: String(e) }); } }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  powerMonitor.on('suspend', () => { paused = true; });
  powerMonitor.on('resume',  () => { paused = false; /* tick soon */ clearTimeout(timer!); timer = setTimeout(tick, 2000); });
  tick();
}
export function stopPoll() { stopped = true; if (timer) clearTimeout(timer); }
```

### Pattern 6: Loopback HTTP with Shared-Secret Token

**What:** Server binds to `127.0.0.1` only, on an ephemeral port. On startup, main writes `{port, token}` to `userData/bridge.json` (0600 perms). The Obsidian plugin reads that file on load. Every request must present `Authorization: Bearer <token>`.

**When to use:** For any local IPC from a separate Electron app (Obsidian) to this one.

**Trade-offs:**
- Pro: Binding to `127.0.0.1` already prevents remote access.
- Pro: Token defends against other local apps (including other Electron apps in the same user session) hitting the port.
- Con: Requires the plugin to be able to read a file path it knows. Fine — it's the same user, same filesystem.
- HTTPS is **not** worth it for loopback. A self-signed cert adds UX friction and doesn't defend against anything loopback + token doesn't already cover. (Obsidian Local REST API uses HTTPS, but that's because it exposes sensitive vault data and wanted to look secure; we're already bearer-protected and same-user-scoped.)

**Example:**
```typescript
// src/app/http.ts
export async function startHttpBridge(svc: Service, dataDir: string) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = Fastify();
  server.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${token}`) return reply.code(401).send();
  });
  server.post('/v1/process', async () => svc.processNow());
  server.post('/v1/label',   async (req) => svc.labelNote((req.body as any).path));
  server.get('/v1/status',   async () => svc.getStatus());
  const addr = await server.listen({ host: '127.0.0.1', port: 0 });
  const port = (server.server.address() as AddressInfo).port;
  fs.writeFileSync(path.join(dataDir, 'bridge.json'), JSON.stringify({ port, token }), { mode: 0o600 });
}
```

### Pattern 7: Mutual Exclusion with CLI via Pidfile

**What:** Before starting the poll loop or running a mutating `svc` method, take an exclusive lock on `userData/data/plaud.lock` (contains pid + mode + started_at). CLI `plaud start` does the same. Lock acquisition fails loudly with a clear message: "PlaudNoteTaker.app is currently running — quit it or stop the CLI."

**When to use:** Any time CLI and app share a data dir.

**Trade-offs:**
- Pro: Prevents double-processing, double-writes to state JSONs, double-polling rate-limit bombs.
- Con: User has to quit one to use the other. Acceptable; matches the expected workflow.

Read-only commands (`plaud speakers list`, `plaud test`) do not take the lock.

---

## Data Flow

### Flow A: New Recording Detected → Note Written → Renderers Notified

```
[setTimeout tick in poll.ts]
    ↓
svc.processNow()  ── takes reentrancy lock ──  emits 'poll:start' log
    ↓
pipeline.processNewRecordings()  ── UNCHANGED code ──
    ↓
PlaudClient.list()     → new IDs filtered against processed-recordings.json
    ↓
for each new recording:
    PlaudClient.download() → audio.convertToWav()
        → assemblyai.transcribe() [HTTP poll, minutes]
        → eagle.recognize()        [CPU, seconds, in-process]
        → gemini.summarize()       [HTTP, seconds]
        → writer.buildMarkdown()
        → writer.writeNoteFile()   [fs write to vault]
        → state.markProcessed()    [fs write to data dir]
    each step emits log events via log.emit()
    ↓
svc releases lock → poll.ts schedules next tick
    ↓
log sinks fire in parallel:
    consoleSink       → stdout (only visible if launched from terminal)
    ipcSink (batched) → webContents.send('log:event', batch) for every open window
    ↓
Popover renderer:    receives log events, updates "busy" indicator, refreshes recent notes
Logs renderer:       appends to virtualized list
Settings renderer:   ignores (not subscribed)
    ↓
(optional) notify.ts → new Notification(...) via macOS native notification center
```

### Flow B: Obsidian Plugin "Process Now" → HTTP → Pipeline → Note Shows in Vault

```
[user hits plaud:process-now in Obsidian command palette]
    ↓
Plugin reads bridge.json once, caches {port, token} in memory
    ↓
obsidian.requestUrl({ url: 'http://127.0.0.1:<port>/v1/process',
                      method: 'POST',
                      headers: { Authorization: 'Bearer <token>' }})
    ↓
Fastify auth hook verifies token → route calls svc.processNow()
    ↓
    IF lock busy: returns { skipped: true, reason: 'busy' } immediately
    ELSE: runs Flow A above
    ↓
HTTP 200 response (or 409 if skipped) — plugin shows a notice
    ↓
Obsidian's own file watcher detects the new .md in the vault → renders
(No direct coupling between Electron app and Obsidian's vault state.
 The file system is the integration point.)
```

### Flow C: Obsidian Plugin "Label Current Note" → HTTP → Enroll → Note Updated

```
[user fills in "Speaker A: Jane" in note, invokes plaud:label]
    ↓
Plugin: activeFile.path  (vault-relative)
       → resolves to absolute via vault.adapter.getFullPath
    ↓
POST /v1/label { path: '<absolute>' }
    ↓
svc.labelNote(path) → existing runLabel(path) code (UNCHANGED)
    ↓
writer.parseLabels → state.loadMeta → plaud download → eagle.enroll → state.saveProfiles
    → writer.applyLabels → fs.writeFile (same note, updated)
    ↓
HTTP 200. Obsidian detects file change, re-renders.
```

### Flow D: Settings Change → Config Reload → Pipeline Sees New Keys Next Poll

```
[user edits API key in Settings renderer, clicks Save]
    ↓
ipcRenderer.invoke('svc:setSecret', { key: 'ASSEMBLYAI_API_KEY', value: '...' })
    ↓
main: ipc.ts handler → secrets.set(key, value) → safeStorage.encryptString → Keychain
    ↓
main: re-runs loadConfigFromApp() → new Config object
    ↓
svc is recreated with new Config (or svc.reloadConfig(newConfig))
    ↓
next poll tick picks up new client instances with new keys
    ↓
emit({ level: 'info', message: 'Config reloaded' }) → visible in Logs renderer
```

Subtlety: **do not** re-create svc mid-operation. Queue the reload; apply after current op completes. The reentrancy lock already serializes, so the simplest pattern is `lock.run('reload', () => { svc = createService(newConfig) })` from the IPC handler.

### Flow E: Startup Sequence (the critical ordering)

```
Electron app ready
    ↓
1. resolveDataDir('app')           ── no filesystem yet, just paths
    ↓
2. acquireLock(dataDir)            ── fail fast if CLI is running
    ↓
3. check ffmpeg in PATH            ── fail fast, show "Install ffmpeg" UI, quit
    ↓
4. runMigration(dataDir)           ── .env → Keychain IF first run; ./data/ → userData/ IF present
        │  (may trigger Keychain prompt — this is the first safeStorage call)
    ↓
5. loadConfigFromApp(dataDir)      ── reads Keychain + settings.json; may be incomplete on first run
    ↓
6. subscribe log sinks             ── console + ipcSink (no windows yet, ipcSink no-ops)
    ↓
7. createService({ config, dataDir })
    ↓
8. startHttpBridge(svc, dataDir)   ── writes bridge.json
    ↓
9. registerIpcHandlers(svc)
    ↓
10. createTray(), createPopover()  ── Tray first; popover window hidden
    ↓
11. IF config complete: startPoll(svc, intervalMs)
    ELSE: open Settings window, show onboarding; startPoll after Save
    ↓
12. register powerMonitor listeners
    ↓
13. svc.testConnections() in background → emit results to logs
    ↓
READY
```

**Ordering invariants (each blocks the next):**
- Lock must be acquired before anything touches data dir files.
- Migration must complete before config loads (migration writes to Keychain, config reads from it).
- Service must exist before IPC handlers register.
- HTTP bridge must exist before tray is shown (so plugin health checks won't race).
- Poll loop must **not** start until config is complete, or it'll spam "missing API key" errors.

### State Management

```
┌─────────────────────────────────────────────────────────────────┐
│  Persistent (on disk, data dir)                                 │
│    processed-recordings.json   — owned by state.ts              │
│    recording-meta.json         — owned by state.ts              │
│    processing-history.json     — owned by state.ts              │
│    speaker-profiles.json       — owned by speakers/profiles.ts  │
│    settings.json               — NEW; owned by src/app/secrets  │
│    bridge.json                 — NEW; owned by src/app/http     │
│    plaud.lock                  — NEW; owned by src/app/lock     │
│  Keychain (macOS)                                               │
│    PlaudNoteTaker/ASSEMBLYAI_API_KEY, GEMINI_API_KEY, …         │
│    via safeStorage-encrypted entries in settings.json OR        │
│    direct Keychain entries via keytar. See tradeoff.            │
├─────────────────────────────────────────────────────────────────┤
│  In-memory (main process)                                       │
│    svc object        (replaced on config reload)                │
│    lock.busy         (reentrancy)                               │
│    poll.paused       (sleep/wake)                               │
│    lastPollAt, lastError  (for status display)                  │
│    recent log ring buffer (last ~500 events, for new windows)   │
├─────────────────────────────────────────────────────────────────┤
│  In-memory (renderers)                                          │
│    Derived view state only — never authoritative.               │
│    On mount, renderer calls svc:getStatus() + svc:getHistory()  │
│    and requests a log backfill from the ring buffer.            │
└─────────────────────────────────────────────────────────────────┘
```

**Key rule:** renderers are disposable. Closing and reopening a window must never lose data. Every renderer boots by pulling current state via IPC, then subscribing to deltas.

---

## Tradeoffs Worth Acknowledging (where there is no single right answer)

### Tradeoff 1: Poll loop in main process vs utilityProcess

**Main process timer (RECOMMENDED for v1):**
- Pro: Simpler. No extra IPC hop. Pipeline modules call into `state.ts` fs operations directly.
- Pro: Log `emit()` reaches sinks (including webContents) without crossing a process boundary.
- Pro: Passing the Config + dataDir is trivial (it's the same process).
- Con: A long synchronous step (e.g., Eagle PCM decoding on a very long file) could jank the tray icon or a focused window.
- Con: An unhandled exception in pipeline crashes the whole app.
- In practice: Pipeline operations are overwhelmingly I/O-bound (HTTP to AssemblyAI/Gemini, fs). The CPU-heavy bit is Eagle, which is already async-friendly per the existing implementation. Main-process is fine at v1.

**utilityProcess (consider for v2 if stability data warrants):**
- Pro: CPU-heavy Eagle work moves off main; UI stays snappy even during enrollment.
- Pro: Crash isolation — pipeline crash doesn't kill the tray app.
- Con: Every log message, every status update, every call crosses a process boundary. More plumbing.
- Con: `state.ts` fs operations must either run in the utility process (and then the IPC handlers for labeling need to route there too) or split — which is worse.
- Con: Eagle's Node addon works in utilityProcess but hasn't been empirically verified in this codebase; needs a spike.

**Decision:** Main process for v1. Revisit only if real users report UI jank during processing, or if we see main-process crashes caused by pipeline bugs. This decision is cheap to reverse: moving `poll.ts` + `svc.ts` into a utility process is a mechanical change once the facade is in place.

### Tradeoff 2: Electron `safeStorage` vs `keytar`

**safeStorage (RECOMMENDED):**
- Pro: Built into Electron; zero native dependencies to maintain.
- Pro: On macOS, encryption key is stored in Keychain with per-app ACL; encrypted blobs sit in `settings.json`.
- Pro: Works identically if you ever port to Windows (DPAPI) or Linux (kwallet/gnome-keyring).
- Con: The encrypted value is in a JSON file, not in Keychain directly. Some users reasonably expect API keys to show up in Keychain Access as individual entries. They won't with safeStorage.
- Con: Known issue: `safeStorage` must not be called before the `ready` event (ensured by our startup sequence). Some reports of Keychain password prompts after Electron upgrades.
- Con: Cannot be read by the CLI — but that's fine, CLI uses `.env`.

**keytar (alternative):**
- Pro: Entries appear as named items in Keychain Access (better for user inspection).
- Pro: CLI could theoretically read the same Keychain entries if we wanted a unified backend later.
- Con: Native module → platform builds, prebuilds, and the occasional Electron-version compat break. Maintenance cost.
- Con: Deprecated by Atom; community-maintained.

**Decision:** safeStorage. The maintenance savings beat the mild inspectability loss. Document in README where to find the encrypted blob.

### Tradeoff 3: One IPC channel vs per-domain channels

**Per-domain channels (RECOMMENDED):**
- Structured as `svc:process`, `svc:label`, `svc:settings.set`, `svc:speakers.list`, `log:event` (broadcast), `status:update` (broadcast).
- Matches the shape of the service facade exactly — one channel per method.
- Easier to type; easier to trace in DevTools.
- Con: More channel names to register.

**Single message bus (`'plaud:rpc'`):**
- One channel, dispatched by message type field.
- Feels DRY but obscures the actual surface.
- Harder to apply channel-level rate limiting or logging.

**Decision:** Per-domain, with one convention: `svc:<method>` for request/response (`ipcMain.handle` / `ipcRenderer.invoke`), and `<domain>:<event>` for broadcasts (`webContents.send` / `ipcRenderer.on`, e.g. `log:event`, `status:update`, `history:update`).

### Tradeoff 4: Poll on a timer vs event-driven ("only poll when idle + reachable")

We could be fancy: only poll when on network, only poll when user is active, back off on 429s more aggressively. That's future work. v1 uses a simple interval with sleep/wake pause. The existing CLI already has 429 backoff in `plaud/client.ts`; we inherit it for free.

---

## Scaling Considerations

This is a single-user desktop app; "scaling" means volume, not users.

| Volume | Adjustments |
|--------|-------------|
| 0–20 recordings/day (typical) | Nothing. Current design handles it trivially. |
| 100+ recordings/day | Lock the poll loop from concurrent runs (already there). Consider queuing recordings and processing in parallel with a semaphore of 2–3 (AssemblyAI is the bottleneck, and it's fine with concurrent uploads). Extend `svc` with a work queue; `state.ts` already tracks processed IDs idempotently. |
| Long recordings (>1h) | Transcription may take 10+ minutes. Status updates to renderers during a long op are essential — the pub/sub logger already delivers this. Consider a "current op" status structure separate from log events. |

**First likely bottleneck:** Keychain prompts on Electron upgrade or codesign change. Cache decrypted values in memory for the process lifetime; re-read only on change or restart.

**Second bottleneck:** Opening the Logs window for the first time triggers a backfill of hundreds of events. Pre-virtualize the list from day one.

---

## Anti-Patterns

### Anti-Pattern 1: Letting renderers hold business state

**What people do:** Popover keeps a local `processedIds` array updated by both IPC events and user actions.

**Why it's wrong:** Truth lives in `state.ts` on disk. Two renderers will disagree within minutes. Reopening a window loses state.

**Do this instead:** Renderers always derive from main. On mount, pull via IPC. Then subscribe to delta events. Main is the only writer.

### Anti-Pattern 2: Calling `src/pipeline.ts` from the HTTP handler

**What people do:** `server.post('/v1/process', () => processRecording(...))` — skips the service facade.

**Why it's wrong:** Now lock state is split between IPC-triggered operations and HTTP-triggered operations. First concurrent run corrupts `processed-recordings.json`.

**Do this instead:** HTTP handlers are one-liners that call `svc`. Same rule for IPC handlers.

### Anti-Pattern 3: Letting `src/*` modules know about Electron

**What people do:** `import { app } from 'electron'` inside `src/state.ts` to compute the data dir.

**Why it's wrong:** Breaks the CLI. `require('electron')` throws outside Electron.

**Do this instead:** `src/*` never imports `electron`. The data dir is passed in. The Electron-aware code lives exclusively in `src/app/`.

### Anti-Pattern 4: Polling Obsidian directly instead of the file system

**What people do:** Build an Obsidian API to push note content back to the app.

**Why it's wrong:** Obsidian's vault file watcher is the integration surface. If we write the file correctly, Obsidian will see it. Anything else is extra moving parts.

**Do this instead:** Pipeline writes `.md` to vault path. Obsidian picks it up. The plugin is only for user-initiated actions going the *other* direction.

### Anti-Pattern 5: HTTPS on loopback

**What people do:** Self-signed cert + cert bundle prompt in the plugin.

**Why it's wrong:** HTTPS defends against network attackers. The network is 127.0.0.1. The real threat (other local apps on the port) is defeated by the bearer token.

**Do this instead:** HTTP + `127.0.0.1` bind + bearer token from `bridge.json`.

### Anti-Pattern 6: Starting the poll loop before the config UI exists

**What people do:** On first run, poll starts, immediately errors on missing API key, shows five error toasts.

**Why it's wrong:** First-run UX is terrible.

**Do this instead:** Startup sequence step 11 is explicit: poll starts only if config is complete, otherwise the Settings window opens and poll starts on first successful save.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Plaud cloud | HTTP via existing `plaud/client.ts` | Inherit retry/backoff. No change. |
| AssemblyAI | HTTP via existing `transcription/assemblyai.ts` | Long polls during transcription; emit status events to keep renderer alive. |
| Gemini | HTTP via existing `summarization/gemini.ts` | No change. |
| Picovoice Eagle | Native addon, in-process | Verified to work in main process. Revisit for utilityProcess only if stability requires. |
| macOS Keychain | Electron `safeStorage` (writes to `settings.json` with Keychain-derived key) | Only reached from main process. |
| macOS Notifications | Electron `new Notification(...)` | Request permission on first use; on denial, degrade silently to log-only. |
| ffmpeg | Spawned as child process (existing `audio.ts`) | Check PATH at startup; show "Install ffmpeg" guidance if missing. |
| macOS Power Monitor | `powerMonitor` events: `suspend`, `resume`, `lock-screen`, `unlock-screen` | Use suspend/resume; ignore lock/unlock. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Renderer ↔ Main | IPC (`invoke`/`handle` for requests; `send`/`on` for broadcasts) via contextBridge-exposed API | Single typed surface in `preload.ts`. Never enable `nodeIntegration`. |
| Obsidian plugin ↔ Main | HTTP on `127.0.0.1:<port>` with bearer token from `bridge.json` | Plugin reads `bridge.json` via `fs` (user-scoped file). |
| Main ↔ src/* pipeline | Direct imports; `Config` and `dataDir` injected at boot | The single abstraction joint. |
| CLI ↔ src/* pipeline | UNCHANGED — direct imports, `.env` config, `./data` (or env override) data dir | CLI path must keep working without any Electron dependency resolved. |
| CLI ↔ App | Pidfile lock in shared data dir | Mutual exclusion, not concurrency. |

---

## Build Order Implications (what blocks what)

This section is the explicit input to the roadmap.

### Phase 0 (must exist before anything else works)
1. **Data dir injection seam.** `state.ts` takes `dataDir`. `paths.ts` resolves it. Both CLI and future app use the same primitive. — *Blocks: every other thing.*
2. **Config loader split.** `config/loader-env.ts` (behavior-preserving extraction of current `config.ts`) + `config/loader-app.ts` (stub that throws "not implemented" for now) + `config/validate.ts` (shared). CLI continues to work against `loader-env`. — *Blocks: Keychain, settings UI.*
3. **Log pub/sub.** `log/core.ts` with console sink. Existing `log.ts` becomes a re-export. CLI output unchanged. — *Blocks: renderer log streaming, status indicators.*

### Phase 1 (Electron skeleton)
4. **Electron main process scaffold.** Tray icon, empty popover, preload + contextBridge, ipcMain.handle scaffold. No pipeline wiring yet. — *Blocks: all renderer work.*
5. **Service facade.** `svc.ts` with reentrancy lock, calling existing pipeline functions. Wired to IPC. — *Blocks: HTTP bridge, renderer actions.*
6. **Secrets + Keychain.** `secrets.ts` using safeStorage. Settings renderer can write API keys. Migration (`.env` → Keychain) runs on first launch if `.env` present. — *Blocks: poll loop start (can't poll without config).*

### Phase 2 (core loop running end-to-end in the app)
7. **Poll loop with lifecycle.** `poll.ts` with suspend/resume. Start after config is complete. — *Blocks: nothing functionally critical after this; feature work can parallelize.*
8. **Log IPC sink + Logs renderer.** Live streaming of pipeline events. — *Unblocks: observability during development of everything that follows.*
9. **Pidfile lock.** CLI and app coordinate. — *Blocks: shipping; can run CLI happily in dev without it.*

### Phase 3 (Obsidian integration)
10. **HTTP bridge.** `http.ts` + `bridge.json`. Verify with `curl`. — *Blocks: Obsidian plugin.*
11. **Obsidian plugin (thin client).** Commands for process/label, reads `bridge.json`. — *Blocks: user-facing milestone done.*

### Phase 4 (hardening)
12. **Power events.** Sleep/wake pause/resume.
13. **Error/crash recovery.** Pipeline exceptions caught at `svc` boundary, surfaced as log events, poll continues.
14. **Rate-limit propagation.** 429 from Plaud surfaces as a "throttled, next poll in Ns" status message.

### Critical ordering rules
- **1 → 2 → 3 before anything in Electron.** These are the shared joints; if they break, both paths break.
- **6 before 7.** Never start polling without config.
- **5 before 10.** HTTP bridge is a transport over the facade; the facade must exist first.
- **4 before 8.** Log streaming needs a window to stream into.
- **Pidfile (9) can slip to just before ship.** Dev workflow tolerates its absence.

---

## Explicit Non-Goals for v1

Naming these so they don't accidentally creep in:

1. **No DI container.** The service factory takes deps as an argument. That's the whole "container".
2. **No event bus library.** The log pub/sub is 30 lines. Renderer event channels are `webContents.send`. Nothing more.
3. **No plugin/extension architecture** inside the Electron app. There's no roadmap for third-party plugins.
4. **No SQLite.** JSON files with in-memory caching continue to work. Revisit only if we add full-text search over notes or history.
5. **No multi-vault support.** One vault path in settings. Multi-vault can be a future milestone.
6. **No HTTPS on loopback.** See anti-pattern 5.
7. **No headless/daemon mode of the app.** If the user wants headless, they use the CLI. The app is the GUI.
8. **No auto-update.** Ship it the old-fashioned way for v1. (This is an architectural non-goal because auto-update sometimes drives structural decisions — e.g., ASAR layout, code signing for updates. v1 codesigns for notarization only.)
9. **No telemetry / crash reporting.** Logs stay local.
10. **No process isolation for the pipeline.** Main-process timer is good enough until proven otherwise.
11. **No swap-ability of transcription/summarization providers at runtime.** If we add a second provider later, we add a new module; we don't build an abstract provider interface now.

---

## Sources

- [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) — main/renderer/utility boundaries
- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) — when to offload
- [Electron IPC Tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc) — invoke/handle and contextBridge patterns
- [Electron contextBridge API](https://www.electronjs.org/docs/latest/api/context-bridge) — renderer surface exposure
- [Electron safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage) — macOS Keychain-backed encryption
- [Electron powerMonitor API](https://www.electronjs.org/docs/latest/api/power-monitor) — suspend/resume events
- [Electron Security Tutorial](https://www.electronjs.org/docs/latest/tutorial/security) — context isolation, renderer hardening
- [Obsidian Local REST API (reference implementation)](https://github.com/coddingtonbear/obsidian-local-rest-api) — prior art for localhost plugin↔app comms (our design deliberately differs on HTTPS)
- [Cameron Nokes: keytar in Electron](https://cameronnokes.com/blog/how-to-securely-store-sensitive-information-in-electron-with-node-keytar/) — background on the keytar alternative
- [Freek: Replacing keytar with safeStorage](https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray) — migration notes
- Existing in-repo docs: `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/STRUCTURE.md`

---

*Architecture research for: Electron menubar wrapper around existing TS pipeline + Obsidian plugin*
*Researched: 2026-04-16*
