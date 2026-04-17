# Phase 3 Execution Brief — Core Daemon

**Goal (from ROADMAP.md):** The installed app behaves as a self-contained daemon — first-run migration, Keychain config, poll loop with sleep/wake resilience, Settings UI, Logs tab, Speakers pane, launch-at-login, menubar icon health states.

**Two parallel agents — split strictly by process boundary.** The IPC contract at `electron/ipc.ts` is the ONLY coordination surface; no other cross-file edits should happen across agents.

---

## Agent A: Main Process

**Owns (exclusive write access):**
- `electron/main.ts` — updates to wire everything
- `electron/app/` — new subsystems (create files as needed)
- `src/config/app-loader.ts` — new, implements the other half of Phase 1's loader-family pattern
- `src/notes/writer.ts` — read-only (poll loop uses `writeNote`)
- All of `src/pipeline.ts` + its dependencies — read-only, called from service facade

**Must NOT touch:**
- `electron/preload.ts`
- `electron/renderer/`
- `electron/ipc.ts` (contract is locked — if you genuinely need a new channel, request here first)

**Deliverables (file-by-file):**

1. **`electron/app/paths.ts`** — Resolve paths in one place:
   - `userDataDir` = `~/Library/Application Support/PlaudNoteTaker/` (dev and prod alike via `app.getPath('userData')` — but override to a fixed name, not "Electron")
   - `dataDir` = `{userDataDir}/data/`
   - `settingsJsonPath` = `{userDataDir}/settings.json`
   - `migrationSentinelPath` = `{userDataDir}/.migration-complete`
   - `pidfilePath` = `{userDataDir}/data/plaud.lock`
   - `ffmpegPath()` = packaged → `resourcesPath/ffmpeg`; dev → `require('ffmpeg-static')`
   - `trayIconPath()` = packaged → `resourcesPath/iconTemplate.png`; dev → repo `electron/assets/iconTemplate.png`
   - `trayIconPath({ state })` — return `iconTemplate.png` or `iconTemplate-error.png` based on state (for now, reuse single icon — generate error variant as a small later task)

2. **`electron/app/secrets.ts`** — Keychain-backed API key storage via Electron `safeStorage`:
   - `setSecret(key: string, value: string): Promise<void>` — encrypt + write to `{userDataDir}/secrets.json` as `{ [key]: base64(encrypted) }`
   - `getSecret(key: string): Promise<string | null>` — read + decrypt; null if missing
   - `deleteSecret(key: string): Promise<void>`
   - Secrets keys: `PLAUD_BEARER_TOKEN`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, `PICOVOICE_ACCESS_KEY`
   - **CRITICAL:** call `app.setName('Plaud Obsidian Note Taker')` at the top of `main.ts` BEFORE any safeStorage use, or Keychain prompts will recur (PITFALLS.md pitfall 7)
   - File permissions on `secrets.json`: 0600

3. **`src/config/app-loader.ts`** — produces same `Config` type as `env-loader.ts`:
   - `loadConfigFromApp(userDataDir: string): Promise<Config | null>` — returns null if Settings incomplete
   - Reads non-secret fields from `{userDataDir}/settings.json` (vaultPath, vaultNotesFolder, templatesPath, selectedTemplate, pollInterval, geminiModel)
   - Reads secret fields via `secrets.getSecret()` — synchronously not possible, so this loader is async (differs from env-loader's sync). That's fine — callers in main process await.
   - `dataDir` = `{userDataDir}/data` (hardcoded; not user-editable)
   - Use the same `required()` / `optional()` helpers from `src/config/validate.ts`. Missing required → return null, not throw (the UI handles "incomplete" state)
   - Write updates: `saveSettings(userDataDir, partial: Partial<ConfigEditable>): Promise<void>` — persists non-secret fields to settings.json; secrets go through `secrets.ts` separately. Saving emits `event:config-changed`.

4. **`electron/app/migration.ts`** — First-run migration:
   - `detectSource(): { envPath, dataDirPath } | null` — search these locations for `.env` + `data/` pair:
     1. `process.cwd()` (covers the developer who ran the CLI here)
     2. repo root resolved from `main.ts`'s `__dirname` (dev mode only — in packaged app, irrelevant)
     3. User can supply via `pickDirectory` IPC call
   - `status(userDataDir)`:
     - sentinel exists → `{ kind: 'none_needed' }`
     - source found and sentinel absent → `{ kind: 'source_found', envPath, dataDirPath }`
     - neither → `{ kind: 'none_needed' }` (first-run UX opens Settings)
   - `run(source, userDataDir)`:
     - Stage into `{userDataDir}.migrating/` (delete first if already exists)
     - Parse `.env` with dotenv, write each secret to Keychain via `secrets.ts`
     - Write non-secret env vars to `{userDataDir}.migrating/settings.json`
     - Copy `source.dataDirPath/*.json` into `{userDataDir}.migrating/data/` with a **byte-for-byte copy** (`fs.copyFileSync`, not parse-and-rewrite). Eagle profile base64 strings must round-trip exactly.
     - Atomic swap: if `{userDataDir}` exists, rename to `{userDataDir}.old-{timestamp}` first, then rename `{userDataDir}.migrating` → `{userDataDir}`
     - Write sentinel `{userDataDir}/.migration-complete` with migration timestamp
     - Return `{ kind: 'complete', migratedAt }`
   - If ANY step fails: `{ kind: 'failed', error }`; leave `.migrating/` for forensics; don't touch original `.env` or `data/` under any circumstance

5. **`electron/app/service.ts`** — Service facade (single mutation point):
   - Reentrancy lock: `Promise`-based. `runPollTick()` holds it; `labelSpeakers()` holds it; both skip if already held.
   - Holds: `plaudClient`, current `Config`, poll-timer handle, `AbortController` for in-flight work.
   - `start(config)`, `stop()`, `restart(config)`, `pollNow()`, `labelSpeakers(notePath)`
   - On config change: if vault/API keys changed, restart; otherwise update in place.

6. **`electron/app/poll-loop.ts`** — Self-rescheduling `setTimeout`:
   - `runTick()`:
     - wrap full body in try/catch; one failure never terminates the chain
     - fetch new recordings, call service.processRecording for each
     - push log events (existing `log` module already subscribed by Phase 1)
     - on success: update `DaemonState = { kind: 'idle', lastPollAt, lastError: null }`
     - on failure: `DaemonState = { kind: 'error', lastError: message }` (tray icon flips to error; notifications fire in Phase 4)
     - emit `event:daemon-state`
   - Scheduling: on success or failure, `setTimeout(runTick, pollIntervalMs)` — never `setInterval`
   - `powerMonitor.on('resume')` → cancel current timer, fire immediate tick after 500ms debounce
   - `powerMonitor.on('suspend')` → `abortController.abort()` for in-flight HTTP so it doesn't stall through sleep

7. **`electron/app/log-buffer.ts`** — Ring buffer of 1000 LogEvents:
   - Subscribe to the pub/sub from `src/log/index.js`
   - Push serializable shape (RendererLogEvent) to all listening webContents via `webContents.send('event:log', ev)`
   - Expose `getBuffer(): RendererLogEvent[]` for initial fetch when Logs window opens
   - **Serialization rule:** strip non-JSON-serializable entries from `args` (e.g., Error objects → `String(err)`)

8. **`electron/app/icon-state.ts`** — Tray icon + DaemonState:
   - Listen for state changes, update tray.setImage with error variant or idle
   - Tooltip: `"Plaud Obsidian Note Taker — last poll: {relative time}"` or `"Error: {message}"`
   - For now, generate a second PNG (`iconTemplate-error.png`) — black mic with a small red dot overlay (can be same as idle for Phase 3; upgrade later)

9. **`electron/app/windows.ts`** — Settings + Logs window factories:
   - `openSettings()` / `closeSettings()` — creates hidden-when-closed BrowserWindow, 720×520, loads Vite dev server URL in dev and `file://` in prod
   - `openLogs()` / `closeLogs()` — same pattern, 800×600
   - Both: `window.on('close', e => { e.preventDefault(); window.hide() })` — close-to-menubar semantics (MBAR-05)
   - Cmd-, accelerator opens Settings (SETT-07) — register via Electron menu even though no menu bar

10. **`electron/app/login-item.ts`** — Launch-at-login:
    - `getEnabled()` = `app.getLoginItemSettings({ type: 'mainAppService' }).openAtLogin`
    - `setEnabled(v)` = `app.setLoginItemSettings({ openAtLogin: v, type: 'mainAppService' })`
    - Log a note if unsigned build: on macOS 13+, unsigned SMAppService is flaky — surface a warning to Logs if `!app.isPackaged || !isSigned()`

11. **`electron/app/single-instance.ts`** — Pidfile lock coordinating with CLI:
    - On main startup (after single-instance-lock but before ffmpeg check): open `dataDir/plaud.lock` with O_EXCL, write pid. If already exists and owner pid is alive, show blocking dialog: "CLI or another copy is running. Quit it first." and `app.exit(1)`
    - On quit: unlink pidfile.
    - CLI (src/cli/start.ts): acquire same lock at startup; release at shutdown. Don't read-only (init/test/label/speakers should still work while app is running).

12. **`electron/main.ts` — wire it all together.** Ordered startup:
    ```
    app.setName('Plaud Obsidian Note Taker')           // BEFORE anything Keychain
    single-instance-lock (existing)
    app.whenReady()
      → paths.ensureDirs()                              // userDataDir, dataDir
      → ffmpeg check → if missing, dialog + app.exit(1)
      → pidfile lock (single-instance-for-data-dir)
      → migration.status()
          ├── 'source_found' → emit event, Settings window shows prompt; daemon stays paused
          └── 'none_needed' → continue
      → app-loader.loadConfigFromApp()
          ├── null → open Settings window, daemon paused (config incomplete banner)
          └── Config → service.start(config), poll-loop.schedule()
      → subscribe log-buffer to pub/sub
      → tray + icon-state.attach
      → register IPC handlers (below)
      → register powerMonitor hooks
    app.on('before-quit') → service.stop(); release pidfile; shut down tray
    ```
- IPC handler registration in `main.ts`: for every channel listed in `electron/ipc.ts`, wire `ipcMain.handle(channel, handler)`. Use a single function `registerIpcHandlers()` in a new `electron/app/ipc-handlers.ts`.

13. **Update `src/state.ts`** (if absolutely needed): NO — Phase 1 already injected dataDir. Main just passes the resolved `userDataDir/data`. Nothing to change.

**Commits (atomic, suggested boundaries):**
- `feat(03-main): paths + secrets + ipc handler skeleton`
- `feat(03-main): app-loader + migration (staging + sentinel, atomic swap)`
- `feat(03-main): service facade + poll loop + powerMonitor + per-tick try/catch`
- `feat(03-main): windows + login-item + icon state + pidfile lock + wire main.ts`

---

## Agent B: Renderer + Preload

**Owns (exclusive write access):**
- `electron/preload.ts` — full rewrite (replace empty stub)
- `electron/renderer/` — everything under this tree
- `electron/vite.renderer.config.ts` — new, if needed for the two HTML entries

**Must NOT touch:**
- `electron/main.ts`
- `electron/app/`
- `electron/ipc.ts`
- `src/*`

**Deliverables:**

1. **`electron/preload.ts`** — Bridge the full PlaudApi surface:
   - Use `contextBridge.exposeInMainWorld('plaudApi', { ... })`
   - For every method in `PlaudApi`, implement via `ipcRenderer.invoke('<channel>', req)`
   - For event listeners (`onLog`, `onDaemonState`, `onConfigChanged`, `onRecentNotesUpdated`), implement via `ipcRenderer.on('<event>', (_, payload) => handler(payload))`, return unsubscribe.

2. **Settings window** (`electron/renderer/settings/index.html` + `index.ts` + `style.css`):
   - Zero framework (vanilla TS + CSS). Keep bundle small; Phase 4 popover has the same constraint; consistent style helps.
   - Left sidebar with tabs: **API Keys / Vault & Templates / Polling & Model / Speakers / About**
   - Tab state in URL hash so Cmd-, always opens to last-used tab
   - API Keys tab: 4 fields (Plaud / AssemblyAI / Gemini / Picovoice), password input + show/hide eye toggle per field, per-field "Test Connection" button that calls `testConnection({ provider, key })` and shows green check / red X + message inline
   - Vault & Templates tab: vault path (text field + "Choose…" button → `pickDirectory`), fallback notes folder (text), templates folder (optional, text + picker), selected template (dropdown; populate after user picks templates folder — for v1 a text field is OK)
   - Polling & Model tab: poll interval (number input, seconds; min 10, max 3600), Gemini model (text, default `gemini-2.5-flash`), launch-at-login toggle
   - Speakers tab: list from `listSpeakers()`, each row with name + Delete button (confirm via `confirm()` dialog before `deleteSpeaker`)
   - About tab: app name, version, links
   - **Save button**: bottom of window, sticky. Disabled while any field invalid. On click → `setConfig({ updates })`. Shows saving/saved state.
   - **First-run migration banner**: top of window; poll `migrationStatus()` on load. If `source_found`, show "Import existing setup?" with Import + Start Fresh buttons. Import calls `runMigration`.
   - **Config-incomplete banner**: if `isConfigComplete()` returns incomplete, show which fields missing.

3. **Logs window** (`electron/renderer/logs/index.html` + `index.ts` + `style.css`):
   - Top strip: "Copy logs" button + entry count + auto-scroll indicator
   - Main area: monospace scrollable list of log entries. Format: `[HH:MM:SS +N.Ns] <level> <message>` matching CLI output
   - Color-code level: info=default, warn=yellow, error=red
   - Initial populate: `getLogBuffer()` at mount; subscribe to `onLog` for new entries
   - Auto-scroll to bottom; if user scrolls up, hold scroll position (detect via `isAtBottom` check on scroll events)
   - Copy: serialize buffer to plain text, `navigator.clipboard.writeText`

4. **`electron/vite.renderer.config.ts`** — Two HTML entries (settings + logs):
   - Multi-page Vite build: `settings/index.html` and `logs/index.html` as entries
   - Register in `forge.config.js` under `plugins: [{ name: '@electron-forge/plugin-vite', config: { renderer: [{ name: 'settings', config: 'electron/vite.renderer.config.ts' }, { name: 'logs', config: 'electron/vite.renderer.config.ts' }] }}]` OR use two separate vite configs — pick whichever is simpler; both are supported.
   - Agent B may need to update `forge.config.js` for the renderer registration ONLY. This is a crack in the strict separation — coordinate with Agent A via comment in git commit message if you do.

**Commits (atomic, suggested boundaries):**
- `feat(03-renderer): preload + contextBridge IPC surface`
- `feat(03-renderer): Settings window (tabs, API keys, vault, speakers)`
- `feat(03-renderer): Logs window (live stream + copy-to-clipboard)`

---

## Cross-agent integration

After both agents return:
- Dev-mode smoke test: `npm run forge:start` → open Settings via Cmd-,, see migration banner, fill in config, save, trigger poll, see logs stream
- Packaged smoke: `npm run forge:package` + run `.app` — same flow
- I'll handle the commit that updates ROADMAP.md / STATE.md / REQUIREMENTS.md traceability and runs final verification.

## Anti-goals

- Don't wire the HTTP bridge (Phase 4)
- Don't wire the popover (Phase 4)
- Don't add native notifications (Phase 4)
- Don't add the Obsidian plugin (Phase 5)
- Don't add automated tests (out of scope per user directive)

## Known hazards (from PITFALLS.md — re-read before starting)

- Call `app.setName(...)` BEFORE any safeStorage import (pitfall 7)
- Migration atomicity: staging dir + sentinel + rename, not in-place edits (pitfall 5)
- Eagle profile bytes must be preserved exactly — byte-for-byte copy (pitfall 5 + ref to commit 8d0a17b in the existing repo history)
- powerMonitor.on('resume') fires multiple times on some macOS versions (pitfall 4) — debounce the catch-up poll
- Hardened-runtime entitlements plist MUST NOT contain `allow-unsigned-executable-memory` (pitfall 3) — we already got this right in Phase 2a, don't regress
