# Phase 4 Execution Brief — User Surface

**Goal (from ROADMAP.md):** The app feels like a native macOS menubar tool — left-clicking the icon shows a popover with recent notes and controls, right-clicking opens a full context menu, native notifications fire for newly saved notes and pipeline errors, and a loopback-only HTTP bridge exposes `/health` and `/label-speakers` for the Obsidian plugin to call.

**Two parallel agents, split by surface:** `electron/ipc.ts` is the coordination contract and must NOT be modified by either agent. Any new IPC need → write to a BLOCKERS file, do NOT edit ipc.ts.

---

## Agent C: Popover

**Owns (exclusive write access):**
- `electron/renderer/popover/*` — new dir with index.html + index.ts + style.css
- `electron/app/popover-window.ts` — new file owning the popover BrowserWindow lifecycle and positioning
- `electron/main.ts` — tray left-click handler and About menu item only (see partition notes below)

**Must NOT touch:**
- `electron/app/notifications.ts`, `electron/app/bridge.ts` (Agent D)
- `electron/preload.ts` (already complete — popover uses same preload via window.plaudApi)
- `electron/ipc.ts`
- `electron/renderer/settings/*`, `electron/renderer/logs/*` (Phase 3, stable)
- Anything in `src/`

### Deliverables

1. **`electron/renderer/popover/index.html`**
   - Same CSP convention as Settings/Logs (self + inline styles allowed)
   - Root layout: compact vertical stack
     - Header row: app name + daemon status dot (green/amber/red for idle/polling/error)
     - Recent notes list (scrollable, max ~340px tall)
     - Empty state (shown when no notes): "No notes yet. New recordings will appear here."
     - Footer strip: "Last poll: N ago" + "Last error: ..." if present
     - Button row: [Poll Now] [Start/Stop toggle] [Settings gear] [Logs]

2. **`electron/renderer/popover/index.ts`**
   - `await window.plaudApi.recentNotes()` on mount → populate list
   - Subscribe `window.plaudApi.onRecentNotesUpdated(...)` → re-render list when main pushes updates
   - Subscribe `window.plaudApi.onDaemonState(...)` → update header dot + footer text
   - Each note row: click → `window.plaudApi.openInObsidian({ filePath })`
   - `Poll Now` button → `window.plaudApi.pollNow()`, show "Polling…" spinner while awaited
   - Start/Stop toggle: read current state via `isDaemonEnabled()`, toggle via `setDaemonEnabled({ enabled })`
   - `Settings` button → `window.plaudApi.openSettings()`
   - `Logs` button → `window.plaudApi.openLogs()`
   - Relative-time formatter: "2m ago", "3h ago", "yesterday", etc.

3. **`electron/renderer/popover/style.css`**
   - Matches Settings/Logs visual language: system font, neutral grays, #007aff accent
   - Dark mode via `prefers-color-scheme`
   - 320px wide, height fits content (~380–520px)
   - Subtle border radius, soft shadow

4. **`electron/app/popover-window.ts`**
   - Exports `togglePopover(tray: Tray)`: if popover is visible, hide it; else show + position anchored to tray icon
   - Uses `tray.getBounds()` + `BrowserWindow.setBounds()` to position the popover directly under the tray icon (centered horizontally over the icon)
   - `frame: false`, `alwaysOnTop: true`, `resizable: false`, `movable: false`, `skipTaskbar: true` (it's menubar-only)
   - Auto-hide on `blur`: when popover loses focus (user clicks away), hide it. Exception: when DevTools is open during dev, don't auto-hide (user is debugging).
   - Same preload + webPreferences as Settings (contextIsolation, sandbox:false, preload path)
   - Loads `getWindowUrl("popover")` — extend the existing URL resolver pattern in `electron/app/windows.ts` (you may add the "popover" entry to that switch in `windows.ts`, but make ONLY that minimal change; do not touch existing settings/logs wiring)
   - Exports `hidePopover()` and `isPopoverVisible()` for other main-process code

5. **`electron/main.ts` partition** (TOUCH ONLY):
   - Add `tray.on("click", () => togglePopover(tray))` to wire left-click
   - Add `openPopover` / `closePopover` hooks on `app.on("second-instance")` — focus popover rather than Settings
   - Wire the About menu item to a simple dialog (already exists in Phase 2a, just keep it)
   - DO NOT change the context menu items Agent D also touches

6. **`electron/app/ipc-handlers.ts` — notes:recent update**:
   - Current implementation returns 72h only
   - New rule: return **max(10 most recent, everything from 72h)**
   - Implementation sketch:
     ```ts
     const all72h = getRecentHistory(dataDir, 72);
     if (all72h.length >= 10) return all72h_sorted_newest_first;
     const wide = getRecentHistory(dataDir, 24 * 365 * 10); // effectively all
     return wide_sorted_newest_first.slice(0, 10);
     ```
   - Sort by `processedAt` descending (newest first)
   - Keep returning the existing `RecentNote[]` shape

7. **`electron/app/windows.ts` — add popover entry** (minimal change):
   - Extend the existing `getDevServerUrl`/`getProductionUrl`/`getWindowUrl` functions to accept `"popover"` in addition to `"settings"` and `"logs"`
   - Popover uses its own Vite renderer entry (Agent C will register it in forge.config.js — see below)

8. **`forge.config.js` — add popover renderer entry** (Agent C touches; Agent D must not):
   - In the `plugins[0].config.renderer` array, add:
     ```js
     { name: "popover", config: "electron/vite.renderer.config.ts" },
     ```
   - Update `electron/vite.renderer.config.ts` to include `popover/index.html` as a rollup input entry alongside settings + logs

### Commits (suggested atomic boundaries)
1. `feat(04-popover): window factory + tray left-click + empty HTML stub`
2. `feat(04-popover): recent-notes rule (max(10, 72h)) + render pipeline`
3. `feat(04-popover): controls (poll-now, start/stop, settings, logs)`

---

## Agent D: Notifications + HTTP Bridge

**Owns (exclusive write access):**
- `electron/app/notifications.ts` — new
- `electron/app/bridge.ts` — new
- `electron/main.ts` — ONLY the notifications init + bridge init + `before-quit` shutdown hooks (see partition notes)
- `electron/app/service.ts` — ONLY the callback wiring (add a `onNoteSaved(note)` / `onError(err)` dispatcher that notifications + bridge consume)
- `package.json` — add `hono` dependency

**Must NOT touch:**
- `electron/renderer/popover/*` (Agent C)
- `electron/app/popover-window.ts` (Agent C)
- `electron/ipc.ts`
- Settings/Logs renderer files (Phase 3, stable)
- `electron/app/ipc-handlers.ts` (no new IPC this phase)
- `forge.config.js` (Agent C handles the renderer entry)

### Deliverables

1. **`electron/app/notifications.ts`**
   - Initialize once at app startup
   - Exposes:
     - `notifyNoteSaved(note: { title: string, filePath: string, folder: string })`: `new Notification({ title: "New note saved: {title}", body: folder, silent: false }); notification.on("click", () => shell.openExternal(`obsidian://open?path=${encodeURIComponent(filePath)}`))`
     - `notifyError(args: { title: string; message: string })`: same API, different text, no click handler required
   - Use `Notification` from `electron`
   - `CFBundleIdentifier` is already set in `forge.config.js` packagerConfig — no changes needed here; notification grouping "just works"
   - First-launch permission prompting: macOS 14+ requires explicit user permission for notifications. Fire one dummy notification silently on startup to trigger the system permission prompt? Or rely on the first real notification? Prefer the former — a one-time "PlaudNoteTaker is ready" notification on FIRST launch (detect via a flag file in userDataDir)
   - In dev (unsigned), notifications are often silently suppressed by macOS. Log `[notifications] Notification fired: {title}` when firing so the behavior is debuggable from the terminal

2. **`electron/app/bridge.ts`**
   - Import Hono: `import { Hono } from "hono"; import { serve } from "@hono/node-server"`
   - Export `startBridge(opts: { userDataDir, dataDir, onLabelSpeakers })` and `stopBridge()`
   - Binds explicitly to `127.0.0.1` (not `0.0.0.0`); use ephemeral port (port: 0)
   - Generate a 32-byte random hex token at startup; write `{ port, token, version }` to `{userDataDir}/bridge.json` with mode `0o600`
   - Routes:
     - `GET /health` → `{ ok: true, version: app.getVersion(), authenticated: authHeader?.startsWith("Bearer") }` (no auth required; helpful for plugin health check UX)
     - `POST /label-speakers` (Bearer token required) → accepts `{ notePath: string }`, validates the path is inside `config.vaultPath` (prevents traversal to `/etc/passwd` etc.), calls `service.labelSpeakers(notePath)`, returns `{ ok, matched, enrolled }` or `{ ok: false, error }`
   - Bearer auth middleware: compare `Authorization: Bearer <token>` against the generated token via constant-time string comparison (`crypto.timingSafeEqual`)
   - Reject non-POST on POST routes and non-GET on `/health` with 405
   - JSON body parsing: `c.req.json()` — fail cleanly on malformed JSON
   - Graceful shutdown: on `app.before-quit`, close the server with a 5s timeout. If timeout exceeds, force-close.
   - Log `[bridge] listening on 127.0.0.1:{port}` + `[bridge] shutdown` so behavior is visible in the logs tab

3. **`electron/app/service.ts` — add event dispatcher** (MINIMAL change):
   - Currently service exposes start/stop/pollNow/labelSpeakers
   - Add a small event surface:
     - `onNoteSaved(cb)`: subscribe to new-note events
     - `onError(cb)`: subscribe to pipeline errors
   - After a successful `processRecording()` → invoke all onNoteSaved subscribers with `{ title, filePath, folder }` (extract from the writer's return)
   - After a caught error in the poll tick → invoke all onError subscribers with `{ title, message }`
   - Keep it simple: `Set<Fn>` pattern (same as Phase 1's log pub/sub)

4. **`electron/main.ts` partition** (TOUCH ONLY):
   - After IPC handlers are registered (step 9 in startup), add:
     ```ts
     const { onNoteSaved, onError } = registerNotifications();   // subscribes to service
     const bridgeHandle = await startBridge({ userDataDir, ... }); // starts Hono
     ```
   - In the `before-quit` handler, call `await stopBridge()` before `serviceStop()`

5. **`package.json`**: add `hono` and `@hono/node-server` to dependencies. These must be bundled into the packaged app's node_modules via Forge (see eagle-node precedent in forge.config.js — if Forge Vite plugin doesn't auto-copy, add as extraResource, but try normal dep first).

### Commits (suggested atomic boundaries)
1. `feat(04-notif): Notification wrapper + service event dispatcher`
2. `feat(04-bridge): Hono server + bridge.json + bearer token + path validation`
3. `feat(04-wire): main.ts init/shutdown for notifications + bridge`

---

## Cross-agent integration

After both agents return, I'll:
- Run `npm run forge:package` and manually smoke-test:
  - Left-click tray → popover appears, shows notes
  - Click Poll Now → log shows poll tick; if a new note is pulled, both a note entry appears in the popover AND a notification fires
  - Force an error (e.g., by breaking the Plaud key temporarily) → error notification + icon error state
  - `curl http://127.0.0.1:<port>/health` (read port from `~/Library/Application Support/.../bridge.json`) → `{"ok":true,...}`
- Update ROADMAP / STATE / REQUIREMENTS traceability
- Commit integration

## Hard constraints (re-read before starting)

- Popover `blur` auto-hide MUST be overridden while DevTools is open, or we lose our primary debugging affordance
- Bridge binds to `127.0.0.1` EXPLICITLY — Node's default listen binds to all interfaces; passing `"127.0.0.1"` as the host is non-optional
- Bearer token comparison MUST be constant-time (`timingSafeEqual`); regular `===` leaks timing info
- `bridge.json` MUST be written with mode `0o600` (readable only by the user; the plugin reads it with the user's creds)
- Notifications in dev builds are often silently suppressed on macOS. When you don't see a toast, check the main-process log for the `[notifications] Notification fired` line before assuming the API is broken
- Do NOT add Hono HTTP endpoints beyond `/health` and `/label-speakers` in this phase. Phase 5's plugin only needs these two.

## Out of scope for Phase 4

- Obsidian plugin (Phase 5 — user has a different approach pending)
- Signing + notarization (Phase 2b, last)
- Any pipeline changes (src/*) — Phase 4 is pure UI + main-process wiring around the existing pipeline
