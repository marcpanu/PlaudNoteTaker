# Feature Research

**Domain:** macOS menubar utility app (Electron, daemon-style) + Obsidian plugin (in-note action button, calls local daemon)
**Researched:** 2026-04-16
**Confidence:** HIGH for menubar/Electron lifecycle APIs and Obsidian plugin APIs (Context7-equivalent official docs); MEDIUM for ecosystem conventions (menubar app UX norms, anti-feature calls derived from cross-reference of multiple community/review sources); HIGH for project-specific scope boundaries (explicitly stated in PROJECT.md).

> Scope reminder: this milestone is a UI wrapper around an already-validated pipeline. The user's directive is "don't over-engineer it — just wrap the existing functionality." Every feature below is evaluated against that directive, not against "what would be nice in a general menubar product."

---

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these makes the app feel broken or unprofessional even for a single-user tool. The bar is "would I myself feel the app was half-finished without it."

#### Menubar presence & lifecycle

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Menubar icon using **template image** (`*Template.png` + `@2x`) | Any icon that doesn't adapt to light/dark menu bar looks amateurish on macOS. This is a 5-minute detail with a huge perceived-polish delta. | LOW | Single grayscale PNG with alpha, filename ending in `Template`. Electron's `Tray` auto-handles dark/light. 18x18 + 36x36. |
| **Left-click opens popover** anchored under the icon | Standard pattern (Fantastical, Things, Linear menubar). Users will click expecting a popover, not a dropdown menu. | LOW | `max-mapper/menubar` library handles anchoring; or roll own with `Tray.getBounds()` + `BrowserWindow` positioning. |
| **Right-click / alt-click context menu** with at least Quit + Preferences + version string | Without this users can't quit the app. A menubar app with no way to exit is a bug. | LOW | `Menu.buildFromTemplate` with Quit / Preferences / "About PlaudNoteTaker v0.x.x". |
| **Hidden from Dock** (`LSUIElement` / `app.dock.hide()`) | This is what makes it a "menubar app" rather than a regular app that happens to also have a tray icon. | LOW | Set `LSUIElement=true` in Info.plist via electron-builder/Forge config. Also dock.hide() defensively in main. |
| **Quit truly quits; close-window hides to menubar** | Closing the Settings window should NOT quit the daemon. Cmd-Q should quit. This is the single most-complained-about bug pattern in Electron menubar apps. | LOW | `window.on('close', e => { e.preventDefault(); window.hide(); })` + separate Quit from context menu / Cmd-Q `before-quit`. |
| **Icon status reflects daemon state** (idle / polling / error) | Glanceable state is the reason the app lives in the menubar. Same-looking icon when polling vs erroring = user has to click to learn anything. | LOW | Swap between 2–3 template PNGs (idle, active-dot, error-exclaim). Keep it to 3 states max — more becomes noise. |

#### Daemon behavior

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Polling continues while popover/Settings window is closed | The whole product value is "runs in background." Regression here = product broken. | LOW | Poll loop lives in main process (already decided in PROJECT.md). Renderer state ≠ daemon state. |
| **Survive display sleep / wake** | macOS puts laptops to sleep hourly. Any app that loses its poll cadence after lid-close is unusable. | MEDIUM | `powerMonitor.on('resume')` → trigger immediate poll + resume interval. Cancel pending HTTP on `'suspend'` so they don't time out into spurious errors. Test this explicitly. |
| **Survive network drop / reconnect** | WiFi drops happen. Failing gracefully (log error, keep polling) vs crashing the poll loop is the difference between daemon and toy. | LOW | Already partly handled in existing pipeline retry logic. Wrap poll tick in try/catch so one failed poll never kills the loop. Surface last-error in UI. |
| **ffmpeg presence verified at startup** | Existing CONCERNS.md flags this. An app that fails silently on a missing dep = user debugging session. | LOW | Resolve bundled ffmpeg path at startup, `execa('ffmpeg', ['-version'])`, fail loudly with a modal if absent. |
| **Single-instance lock** | Double-clicking the app in /Applications while it's already running should focus the existing instance, not spawn a second polling daemon hammering Plaud's API. | LOW | `app.requestSingleInstanceLock()` at top of main. Release it in `before-quit`. |

#### Notifications

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Native macOS notification on "new note saved"** | This is the primary signal that the product is doing its job. Without it, users check Obsidian manually and the menubar app adds no value over the CLI. | LOW | `new Notification({title, body})`. Requires Notification entitlement in signed build. Set `CFBundleIdentifier` so Notification Center groups them. |
| **Click notification → opens note in Obsidian** | A "new note" notification you can't click to jump to is a sub-par experience vs every other macOS productivity app. | LOW | `notification.on('click', () => shell.openExternal(\`obsidian://open?path=...\`))`. Obsidian URI scheme is stable. |
| **Native notification on error** (quota, API down, config broken) | Silent failures in a background app = user discovers problems days later when a recording is missing. | LOW | Same API as success notification. Gate behind a "notify on error" preference defaulted ON. |

#### Settings / preferences

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Dedicated Settings window** (not a giant popover) | Popover is for glance + quick-action. Configuring API keys, templates, and polling interval in a 300px-wide popover is painful. Settings = separate BrowserWindow. | LOW | Standard `BrowserWindow` with fixed size (~640x480), tab-style sidebar. Closing this window hides it, doesn't quit. |
| **API keys stored in macOS Keychain**, not plaintext | PROJECT.md explicitly requires this. Also: pasting keys into a GUI field and having them end up in `~/Library/Application Support/.../config.json` in cleartext would be a security regression from `.env`. | LOW | Electron's `safeStorage` API (built-in, no native dep) or `keytar` (older, still works). `safeStorage` is the modern choice — uses Keychain on macOS, no extra install. Call only from main process. |
| **Password-style masked input** for key fields with show/hide toggle | Users paste keys while screen-sharing, doing demos, etc. Cleartext-by-default is a footgun. | LOW | `<input type="password">` + eye-icon toggle. Standard pattern. |
| **Test-connection button per API provider** | `plaud init` CLI already tests connections. The GUI should match that affordance. Without it, a typo'd key = hours of "why isn't it polling?" debugging. | MEDIUM | Reuse existing connection-test code from `plaud init`. One button per provider: Plaud, AssemblyAI, Gemini, Picovoice. Show green check / red X + error message. |
| **Browsable vault path picker + templates folder picker** | Typing absolute POSIX paths into a text field is a Linux-developer-tool pattern. macOS users expect `dialog.showOpenDialog`. | LOW | `dialog.showOpenDialog({properties: ['openDirectory']})`. |
| **Validation before save** (path exists, interval is a number, etc.) | Saving garbage config and discovering it during the next poll cycle is worse than inline validation. | LOW | Disable Save button on invalid state; show error text inline per field. |

#### First-run / onboarding

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Detect existing `.env` + `data/` and offer one-click migration** | PROJECT.md requires this. Forcing re-enter of 4 API keys + re-training speakers on every reinstall = hostile. | MEDIUM | On first run, look for `.env` in a known list of locations (repo dir, user-supplied via picker). Show modal: "Found existing setup at X. Migrate keys to Keychain and state to Application Support? [Migrate] [Start Fresh] [Choose folder...]". Leaves originals untouched. |
| **Empty-state in popover when no notes yet** | A popover that renders a blank box on first run looks broken. | LOW | "No notes yet. New recordings will appear here." + link to Settings if unconfigured. |
| **First-run walks user to Settings if unconfigured** | "I launched it and nothing happened" is the #1 onboarding failure pattern for menubar apps. | LOW | On startup, if Keychain has no keys OR vault path is unset → open Settings window automatically instead of going straight to menubar-only. |

#### Error recovery / debugging

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Live log stream in a Logs tab** | PROJECT.md requires. This is the primary debugging affordance when something is wrong — required because there's no CLI output to tail. | MEDIUM | Pipe existing `log` module output to a ring buffer in main (e.g. last 1000 lines), push to renderer via IPC. Auto-scroll with "scroll lock when user scrolls up" behavior. |
| **Copy-logs-to-clipboard button** in the Logs tab | The only way to share logs when filing a bug against yourself later is to copy them out. `cat ~/Library/Logs/...` is not a reasonable instruction when you're debugging in production. | LOW | One button, serializes current buffer to clipboard. |
| **"Last poll: X ago" / "Last error: ..." surfacing in popover** | Without this the user can't tell if the daemon is healthy without digging into logs. | LOW | Small footer strip in popover. Text updates on each poll tick. |
| **Error notification includes enough info to act on** | "Something went wrong" notifications are useless. "Plaud API returned 429 (quota)" is actionable. | LOW | Pass through API error message + status code. Already surfaced by existing modules; just wire it. |

#### Obsidian plugin — table stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Renders "Match speakers" button inside notes with an Unknown Speakers callout** | Entire reason the plugin exists (per PROJECT.md). | MEDIUM | `registerMarkdownPostProcessor((element, ctx) => ...)`. Detect the callout block, inject a button as a sibling or replace. Works in Reading View; may need `registerEditorExtension` for Live Preview. Test both modes. |
| **Button shows running / success / error status inline** | Clicking a button that gives no feedback = user clicks 5 more times and creates a queue of duplicate requests. | LOW | Tri-state: idle → spinner → check/X. Disable button while pending. Show error text beneath on failure. |
| **Uses `requestUrl()` not `fetch()`** to call localhost | Obsidian's app origin (`app://obsidian.md`) is subject to CORS for plain `fetch()`. `requestUrl()` is the documented Obsidian API that bypasses CORS and is the best practice. Even for 127.0.0.1 this matters — Chromium's CORS enforcement applies. | LOW | Import `requestUrl` from `obsidian`. API matches fetch loosely. |
| **Settings tab with daemon port + optional health check** | Even if port is fixed (say 47823), users will eventually want to change it to resolve a collision. Minimal config = port field + "Test connection" button that hits `/health`. | LOW | Standard `PluginSettingTab` subclass with one `Setting`. |
| **Gracefully handles daemon-not-running** | If the menubar app isn't running, the button must fail with a clear message ("Menubar app not reachable — is PlaudNoteTaker running?"), not hang or throw. | LOW | Timeout + specific ECONNREFUSED / fetch error text. Show via `new Notice(...)` and inline status. |
| **`manifest.json` declares correct `minAppVersion`** | Obsidian refuses to load plugins with missing/invalid manifests. | LOW | Standard scaffolding. |

---

### Differentiators (Optional Polish — Worth It If Cheap)

Features that elevate the app from "works" to "feels nice." None of these are required. For this project, the filter is: include only if **trivial** and genuinely improves daily use for a single power user.

| Feature | Value Proposition | Complexity | Include? |
|---------|-------------------|------------|----------|
| "Poll now" button in popover | Impatience is real. Sometimes you just finished a meeting and want it processed *now*. PROJECT.md lists this as Active; keep. | LOW | YES — already in scope. |
| Start / stop polling toggle in popover | Useful for "I'm about to hit quota and don't want to process anything for the next hour." PROJECT.md already in scope. | LOW | YES — already in scope. |
| Click recent note → open in Obsidian | Already in PROJECT.md. Turns popover from passive display into useful jump-list. | LOW | YES — already in scope. |
| Launch-at-login toggle | One line of code, meaningful UX. Most background utilities have it. | LOW | YES — already in scope. See dependency note: **requires signed build for reliable SMAppService behavior on macOS 13+**. `app.setLoginItemSettings({openAtLogin: true})` works on older methods; on 13+ behavior improved with `SMAppService`, which Electron wraps via the same API but expects code-signed binary. Unsigned/ad-hoc builds may prompt or silently fail. |
| Grouping of notifications by source (Notification Center stacks) | One `CFBundleIdentifier` → Notification Center auto-groups. Free polish. | LOW | YES — just don't ship with a placeholder bundle ID. |
| Keyboard shortcut to open popover | Power users install menubar apps partly for "Cmd+Shift+P → popover open." | LOW | MAYBE — `globalShortcut.register()`. Risk: conflicts with user's existing shortcuts. Add only with a user-configurable accelerator and default to unset. |
| Speaker management pane lists profiles with sample stats | Just listing names is fine. Adding "enrolled from N recordings" is nicer. | LOW | YES, if the data is already in `speaker-profiles.json`. Otherwise skip. |
| "Reveal in Finder" on recent notes | Right-click context menu on a note list item → `shell.showItemInFolder(path)`. Obsidian is canonical but Finder is sometimes what you want. | LOW | NICE-TO-HAVE — trivial add but not required. |
| Obsidian plugin: status bar item showing daemon health | Syncthing-status plugin is the reference pattern. A tiny colored dot in the bottom bar shows "daemon up" without opening any note. | LOW | MAYBE — polls `/health` every 10–30s. Cheap but adds a recurring HTTP request from Obsidian. Defer unless the daemon-not-running problem actually surfaces in daily use. |
| Obsidian plugin: Command palette commands (e.g. "Match speakers for current note") | Mirrors the button as a keyboard-accessible command. Low cost. | LOW | YES — `this.addCommand({id, name, checkCallback})`. Power-user affordance at almost zero cost. |
| Sound on "new note saved" notification | Attention-grabbing but also annoying. Most menubar utilities default OFF. | LOW | NO — silent by default. Can revisit if the user actually misses notifications. |
| In-app "About" window with version / links | Cute. Not necessary — right-click menu with version string is enough. | LOW | NO — right-click context menu item is sufficient. |
| Tooltip on menubar icon showing state | Hover tooltip like "PlaudNoteTaker — last poll 2m ago". | LOW | NICE-TO-HAVE — `tray.setToolTip()`, one line. Worth doing. |

---

### Anti-Features (Deliberately NOT Building)

Features that many menubar apps and Obsidian plugins have, which would be wrong for *this* project. Include the "why not" specific to this milestone.

| Feature | Why Other Apps Have It | Why Not Here | Alternative |
|---------|-----------------------|--------------|-------------|
| **Auto-update** (electron-updater + GitHub Releases) | Standard for distributed apps; Bartender, Rectangle etc. all ship updates this way. | PROJECT.md explicitly out of scope. Single user; rebuild-and-drag is fine. Adds GitHub Releases infra, signing complexity, update server, rollback testing — massive cost for a personal tool. | Manual rebuild. If this ever becomes painful, revisit. |
| **Crash reporting / telemetry** (Sentry, crashReporter upload) | Shipped apps need production crash visibility. | Single user is their own telemetry. Local logs are sufficient. Adds infra + privacy surface for zero benefit. | Local `log` file + copy-to-clipboard in Logs tab. |
| **Welcome screen with product tour / tutorial overlays** | Consumer apps need onboarding to retain users. | User built the thing. First-run = Settings window, not a 5-slide tour. | First-run auto-opens Settings. That's the onboarding. |
| **Menubar icon rearrangement / "Bartender-style" icon management** | Some menubar apps include features to control other apps' icons. | Totally out of scope — we're a utility, not a menubar manager. | N/A. |
| **Full note search / filter / browse UI in popover** | Todoist, Things, etc. have rich in-menubar browsing. | PROJECT.md explicitly out of scope. Obsidian is the canonical note browser. Duplicating its features is both wasteful and inferior to Obsidian's own. | Popover shows last 72h only. Click → open in Obsidian. That's it. |
| **Reprocess-recordings UI** | Many pipeline tools offer "re-run on past data." | PROJECT.md explicitly out of scope per user. The milestone is specifically a wrapper, not new pipeline functionality. | CLI still works for reprocessing if ever needed: `npx tsx src/index.ts ...`. |
| **Trigger-recording-from-Obsidian button** | Symmetric-looking UX (if plugin can label, why not record?). | PROJECT.md out of scope. Plaud device handles recording. Plugin is intentionally read-only except for the one speaker-match action. | User uses the Plaud device. Plugin stays minimal. |
| **LAN / remote access to daemon** (bind to 0.0.0.0, ngrok, etc.) | Some self-hosted tools offer remote UI. | PROJECT.md explicitly loopback-only. No auth layer; no need for one if we never leave 127.0.0.1. | Bind strictly to `127.0.0.1`. Reject non-loopback via `server.listen('127.0.0.1', port)` *explicitly* (Node defaults to all interfaces otherwise). |
| **Authentication on the local HTTP bridge** | Any public HTTP endpoint needs auth. | Loopback-only + single-user machine means any process that can reach 127.0.0.1 is already running as the user. Adding token auth buys near-zero security and adds "where do I store the token" complexity on both sides. | Document explicitly: "HTTP bridge trusts 127.0.0.1 callers. Do not expose this port." Optional: check `Origin` header is `app://obsidian.md` as a weak sanity check. |
| **Cross-platform (Windows/Linux builds)** | Most Electron apps go cross-platform "for free." | PROJECT.md explicitly out of scope. macOS-only. Keychain, menubar conventions, notarization are all macOS-specific. Removing the cross-plat constraint simplifies a LOT of code. | Hard-code macOS assumptions. Don't apologize for it. |
| **Public distribution (App Store, DMG for strangers)** | Typical endgame for a polished app. | PROJECT.md out of scope. Signed+notarized Developer ID build that the user installs on their own machine is it. | Local build artifact. |
| **Sandboxed / App Store compliant** | Required for MAS. | Sandboxing is incompatible with (a) bundled ffmpeg shellout and (b) writing to arbitrary user-selected vault paths. PROJECT.md acknowledges this. | Ship Developer-ID-signed (not sandboxed). User installs via drag-to-Applications. |
| **Keychain-backed secret sync across devices** | Fancy secure-storage apps do this. | Single user, single machine. Overkill. | Plain local Keychain via `safeStorage`. |
| **Menubar icon animation during polling** | "Spinning" icons look live. | Polling every 30–60s means the icon would spin constantly = visual noise. Static icon with distinct "error" state is better. | 3 static states: idle / error / (optionally) active-dot while a specific transcription is running. |
| **Logs persisted to disk / log rotation** | Production apps need this. | In-memory ring buffer of last ~1000 lines is enough for a personal tool. Copy-to-clipboard is the export mechanism. Adds FS pressure and cleanup logic to add anything more. | In-memory buffer + copy-to-clipboard. The existing CLI's console output is gone once the GUI takes over — that's fine. |
| **Obsidian plugin: inject buttons on *every* note** | "Add action bar to all notes" is a popular plugin pattern. | We specifically only want the button on notes with an Unknown Speakers callout. Rendering buttons globally would be visual pollution on unrelated notes. | Post-processor detects the callout pattern and only injects there. |
| **Obsidian plugin: ribbon icon + sidebar view** | Common plugin real estate. | No value — the button lives in the note itself, which is where the user is. A ribbon icon for "open menubar app" is redundant with Cmd+Tab. | Settings tab + optional command palette command only. |
| **Obsidian plugin: internal retry / queueing of failed requests** | Good distributed-systems hygiene. | The daemon already has retry logic. The plugin's job is to call once, report result. Adding plugin-side queueing introduces two sources of truth. | Single request. Show error. User clicks again if they want to retry. |
| **Obsidian plugin: WebSocket for live status from daemon** | Real-time-feel is nice. | The speaker-match operation is synchronous-enough (seconds, not minutes). A single HTTP POST that blocks and returns a result is simpler and sufficient. | HTTP POST, renderer shows spinner, response updates button state. |
| **Global keyboard shortcut for "poll now"** | Menubar apps often expose shortcuts. | Low value — you already clicked into the popover. Global shortcuts are precious real estate. | Only a global shortcut for "open popover" (optional, unset default). |
| **Dock icon mode as user preference** | Some menubar apps let the user toggle visibility in Dock. | Ambiguous scope; adds complexity to window lifecycle. Just ship as menubar-only. | Hard-coded `LSUIElement=true`. |

---

## Feature Dependencies

```
FOUNDATIONAL (other features assume these exist)
└── Code signing + notarization (Apple Developer ID)
    ├── requires──> Reliable launch-at-login (SMAppService on macOS 13+)
    ├── requires──> Native notification delivery without warnings
    └── requires──> Keychain access without prompting-every-time

Menubar presence
└── Tray icon + popover
    ├── requires──> Template images for dark/light
    ├── requires──> LSUIElement=true (no Dock icon)
    └── requires──> Single-instance lock (prevent dupes)

Settings window
├── requires──> Keychain integration (safeStorage) for API key storage
├── requires──> IPC between renderer and main (main owns secrets)
└── test-connection buttons
    └── requires──> Existing `src/*.ts` connection-test code surfaced via IPC

First-run migration
├── requires──> Detection of existing `.env` + `data/` in a known set of paths
├── requires──> Keychain write path (depends on safeStorage)
└── requires──> Data dir relocation to ~/Library/Application Support (already planned)

Notifications
├── requires──> CFBundleIdentifier set (for grouping in Notification Center)
├── requires──> Notarization (unsigned notifications may be suppressed on newer macOS)
└── click → open-in-Obsidian
    └── requires──> Obsidian URI scheme construction (file path → obsidian://open?path=...)

Daemon reliability
├── requires──> powerMonitor suspend/resume hooks
├── requires──> Try/catch per poll tick (one failure ≠ loop death)
└── requires──> ffmpeg verified at startup

Logs tab
└── requires──> `log` module output rerouted from console to in-memory buffer + IPC

Obsidian plugin button
├── requires──> registerMarkdownPostProcessor detection of Unknown Speakers callout
├── requires──> requestUrl() (NOT fetch()) to call 127.0.0.1 bridge
├── requires──> Local HTTP bridge endpoint (menubar side)
└── status indicator
    └── requires──> Tri-state rendering + inline error text

Obsidian plugin settings tab
├── requires──> Port configurability (default fine, but exposed)
└── test-connection button
    └── requires──> /health endpoint on menubar-side HTTP bridge

Launch-at-login (CONDITIONAL)
└── reliably requires──> Signed + notarized build (for SMAppService on macOS 13+)
    ├── unsigned: may prompt user on every launch, or silently fail
    └── signed: just works
```

### Dependency Notes

- **Code signing is a prerequisite, not a polish item.** Several table-stakes features (launch-at-login, Keychain-without-prompting, Notification Center delivery) degrade or break in unsigned builds. Signing is already in-scope per PROJECT.md and must land before these features are meaningfully testable.
- **Launch-at-login requires signed binary for SMAppService.** Electron's `app.setLoginItemSettings` internally uses `SMAppService` on macOS 13+. Unsigned builds may prompt, fail, or be removed by the OS. Test on a signed build only.
- **Keychain via `safeStorage`** works in development (uses a fallback encryption key) but only gives real Keychain guarantees on a signed, notarized build. First-run migration results are only final on a signed build.
- **The HTTP bridge is foundational for the Obsidian plugin.** Plugin development blocked until the menubar side exposes at least `POST /label` and `GET /health`.
- **`requestUrl()` vs `fetch()` is a correctness issue, not a style preference.** Chromium's CORS enforcement in Obsidian's renderer blocks `fetch()` to 127.0.0.1 under `app://obsidian.md` origin. `requestUrl()` is the documented bypass and uses the underlying platform HTTP stack.
- **Poll-tick isolation (try/catch around each tick) enables "Last error: ..." surfacing** without conflating transient errors with fatal ones.
- **Global shortcut conflicts with other apps if hard-coded.** Only ship as user-configurable with default unset.

---

## MVP Definition

### Launch With (v1 — this milestone)

Minimum to declare the wrapper complete. Matches PROJECT.md "Active" list, with complexity annotations.

- [ ] **Menubar icon + popover** (template image, template@2x, left-click popover, right-click menu with Quit/Preferences/version) — LOW
- [ ] **LSUIElement=true** (no Dock icon), single-instance lock — LOW
- [ ] **Close-to-menubar vs Cmd-Q quit semantics** — LOW
- [ ] **Icon status states** (idle / error; skip "active" if it introduces flicker) — LOW
- [ ] **Popover: recent notes (72h) list, click-to-open in Obsidian, Start/Stop/Poll-now, footer showing last-poll-time** — MEDIUM
- [ ] **Settings window** (tabbed: API Keys / Vault / Templates / Polling / Speakers / Logs) — MEDIUM
- [ ] **API keys in Keychain via safeStorage**, password inputs with show/hide, test-connection buttons per provider — MEDIUM
- [ ] **Folder pickers** for vault + templates via `dialog.showOpenDialog` — LOW
- [ ] **Speaker management pane** (list + delete) — LOW
- [ ] **Live log stream + copy-to-clipboard** — MEDIUM
- [ ] **First-run migration** (detect `.env` + `data/`, offer migrate) — MEDIUM (nontrivial edge cases: partial configs, user who wants fresh start)
- [ ] **Launch-at-login toggle** (state persisted; honored on next reboot) — LOW (but depends on signed build)
- [ ] **Native notifications** on new note (click → open in Obsidian) and on errors — LOW
- [ ] **Daemon resilience**: `powerMonitor` resume hook, per-tick try/catch, ffmpeg presence check at startup — LOW–MEDIUM
- [ ] **Local HTTP bridge** on 127.0.0.1 only, minimum endpoints: `POST /label-speakers` (body: `{notePath}`), `GET /health` — MEDIUM
- [ ] **Obsidian plugin**: markdown post-processor injects "Match speakers" button on Unknown Speakers callout; tri-state status; uses `requestUrl()`; settings tab with port + test-connection — MEDIUM
- [ ] **Signed + notarized build** via user's Developer ID — NONTRIVIAL (one-time setup; recurring cost is low once the pipeline works)

### Add After Validation (v1.x — if and only if the single user asks for it)

Items that are small, valuable-if-wanted, and safe to defer.

- [ ] "Reveal in Finder" context-menu on recent notes — trigger: user says "I sometimes want to see the file"
- [ ] Obsidian plugin status bar item (daemon health dot) — trigger: daemon-not-running issue actually bites
- [ ] Obsidian plugin command palette commands — trigger: keyboard-driven workflow actually desired
- [ ] Global shortcut for popover (user-configurable, default unset) — trigger: asked for
- [ ] Tooltip on tray icon with last-poll time — trigger: "when did it last poll?" question arises

### Future Consideration (v2+ — deferred, probably forever)

Explicitly NOT on the roadmap. Listed only so future-Marc doesn't re-invent them.

- [ ] Auto-update — only if manual rebuilds become annoying enough to matter
- [ ] Windows/Linux — only if the user switches platforms
- [ ] Full note browser in popover — explicitly anti-feature
- [ ] Reprocess-recordings — explicitly anti-feature
- [ ] LAN/remote access — explicitly anti-feature
- [ ] Public distribution — explicitly anti-feature

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Menubar icon + popover + correct lifecycle | HIGH | LOW | **P1** |
| Close-to-menubar vs Cmd-Q semantics | HIGH | LOW | **P1** |
| Icon status indicator (2–3 states) | MEDIUM | LOW | **P1** |
| Settings window + API keys in Keychain | HIGH | MEDIUM | **P1** |
| Test-connection buttons | HIGH | MEDIUM | **P1** |
| Native "new note" notification + click-to-open | HIGH | LOW | **P1** |
| Native error notifications | HIGH | LOW | **P1** |
| powerMonitor resume + per-tick try/catch | HIGH | LOW | **P1** |
| ffmpeg presence check at startup | HIGH | LOW | **P1** |
| First-run migration from `.env`/`data/` | HIGH | MEDIUM | **P1** |
| Recent-notes list + click-to-open in Obsidian | HIGH | LOW | **P1** |
| Start/stop/poll-now controls | MEDIUM | LOW | **P1** |
| Speaker management pane | MEDIUM | LOW | **P1** |
| Live log stream + copy-to-clipboard | HIGH | MEDIUM | **P1** |
| Local HTTP bridge on 127.0.0.1 (2 endpoints) | HIGH | MEDIUM | **P1** |
| Obsidian plugin "Match speakers" button | HIGH | MEDIUM | **P1** |
| Obsidian plugin settings tab (port + health test) | MEDIUM | LOW | **P1** |
| Launch-at-login toggle | MEDIUM | LOW | **P1** |
| Signed + notarized build | HIGH (enables others) | NONTRIVIAL (one-time) | **P1** |
| Single-instance lock | MEDIUM | LOW | **P1** |
| Tooltip on tray icon | LOW | LOW | **P2** |
| Obsidian command palette commands | LOW | LOW | **P2** |
| Reveal-in-Finder context menu | LOW | LOW | **P2** |
| Obsidian plugin status bar health dot | LOW | LOW | **P2** |
| Global shortcut to open popover | LOW | LOW | **P3** |
| Sound on notifications | LOW | LOW | **P3 (skip)** |
| Auto-update | LOW (for single user) | HIGH | **P3 (skip)** |
| Crash reporting / telemetry | ZERO | HIGH | **SKIP** |
| Menubar icon animation | ZERO | LOW | **SKIP** |

**Priority key:**
- **P1**: Required for v1. Missing any P1 = milestone not done.
- **P2**: Post-v1. Add only if a concrete need arises.
- **P3**: Nice to have; likely to never ship. Fine to not do.
- **SKIP**: Explicit anti-features. Document the decision so it doesn't come up again.

---

## Cross-Product Feature Analysis

Not a competitor analysis (no competitor exists for this use case) but a pattern comparison — how well-regarded apps in related categories handle the same problems.

| Pattern | Fantastical (calendar) | Things (tasks) | Tailscale (daemon) | Our Approach |
|---------|----------------------|----------------|-------------------|--------------|
| Menubar popover | Rich, full-featured — a whole app in a popover | Minimal — just a glance + "add task" | Status + key actions | Minimal: recent notes + controls. Don't re-build Obsidian. |
| Settings | Separate window with tab sidebar | Separate window, single-pane | Separate window, tabs | Separate window, tabs (keys / vault / polling / speakers / logs) |
| Dock icon | Has full Dock app + menubar companion | Has full Dock app | Menubar-only | **Menubar-only.** No Dock icon at all. |
| Notifications | Rich with action buttons | Basic | Occasional, only on state change | Minimal: "new note saved" (click → open) + errors. No action buttons (not needed). |
| Error recovery | In-app error UI + alerts | Mostly hidden — silent retry | Visible connection state in tray | Error state reflected in tray icon + native error notifications + Logs tab |
| Launch-at-login | Yes, signed | Yes, signed | Yes, signed + SMAppService | Yes, requires signed build |
| First-run | Welcome tour | Minimal setup screen | Sign-in flow | **Detect-existing-config migration flow** (unique: we have data to import) |
| Keychain for secrets | N/A | N/A | OAuth tokens | Yes — API keys |
| Logs UI | None exposed | None | Yes, in-app | Yes, in-app + copy-to-clipboard |
| HTTP bridge for IPC with another app | N/A | N/A | Yes — tailscaled daemon | Yes — 127.0.0.1 only, no auth |

| Pattern | Syncthing Status (Obsidian plugin) | Local REST API (Obsidian plugin) | Our Plugin Approach |
|---------|-----------------------------------|----------------------------------|----------------------|
| Calls localhost daemon | Yes (polls every few seconds) | N/A (is the daemon) | **Yes, on user click** (no polling; pull-based) |
| CORS handling | `requestUrl()` | N/A | `requestUrl()` |
| Status indicator | Status bar icon, always visible | None | **Inline in the note**, only while button is active; plus optional status bar dot later |
| Injects UI into notes | No | No | **Yes** — post-processor button |
| Settings tab | Yes — host, port, apikey | Yes — port, cert, auth | **Yes** — port, test-connection button |
| Command palette | Yes | Yes | **P2** — add later if wanted |
| Handles daemon-not-running | Shows disconnected status | Plugin *is* the daemon — N/A | Error toast + inline error text with clear "is PlaudNoteTaker running?" message |

Key insight: **the Syncthing Status plugin is the closest reference implementation** for our Obsidian plugin's daemon-communication pattern. Worth reading its source.

---

## Confidence Assessment

| Area | Confidence | Reason |
|------|------------|--------|
| Electron menubar APIs (Tray, BrowserWindow, Notification, powerMonitor, safeStorage, app.setLoginItemSettings) | HIGH | Cross-referenced official Electron docs; multiple years of stable API |
| Template image conventions (dark/light icons) | HIGH | Electron docs explicit; Apple HIG explicit |
| Obsidian plugin API (registerMarkdownPostProcessor, requestUrl, PluginSettingTab) | HIGH | Official Obsidian developer docs; obsidianmd/obsidian-api typings |
| CORS behavior with `fetch()` vs `requestUrl()` | HIGH | Multiple Obsidian forum threads with authoritative replies; documented as the recommended path |
| SMAppService + signing interaction for launch-at-login | MEDIUM | Electron docs mention it; precise failure modes in unsigned builds are hard to pin down without testing. Recommendation: test launch-at-login only on a signed build. |
| Notification delivery requirements post-macOS 14 (entitlements, bundle ID) | MEDIUM | Known to work with Developer ID signing; subtle edge cases (notification permission prompt first-launch) are real. Verify on first signed build. |
| "Menubar app UX conventions" (what users expect) | MEDIUM | Synthesized from multiple review/landscape articles + reference apps (Fantastical, Things, Linear, Tailscale). Not from a single authoritative spec — there isn't one. |
| Anti-feature calls specific to this project | HIGH | Directly grounded in PROJECT.md "Out of Scope" + user's explicit "don't over-engineer" directive |

### What I might be missing

- **Obsidian Live Preview mode quirks.** `registerMarkdownPostProcessor` runs in Reading View. Live Preview uses a CodeMirror 6 extension. For the button to appear in Live Preview (which most users live in), may need a separate `registerEditorExtension` path. Flag this for the plugin implementation phase — might need its own research spike.
- **Notarization timing with Apple.** First-time notarization can take minutes to an hour. Not a design issue but a build-pipeline issue worth flagging for phase planning.
- **`@picovoice/eagle-node` + Electron's Node ABI.** `@electron/rebuild` handles this but will add ~30s to installs. Dependency already flagged in PROJECT.md Key Decisions.

---

## Sources

**Electron / macOS menubar:**
- [max-mapper/menubar (GitHub)](https://github.com/max-mapper/menubar) — high-level popover library
- [Electron: Menu API](https://www.electronjs.org/docs/latest/api/menu/)
- [Electron: nativeImage (Template images)](https://www.electronjs.org/docs/latest/api/native-image)
- [Electron: powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)
- [Electron: safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [Electron: app (setLoginItemSettings)](https://www.electronjs.org/docs/latest/api/app)
- [Electron: Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron Forge: Signing a macOS app](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Building a menu bar application with Electron and React (LogRocket)](https://blog.logrocket.com/building-menu-bar-application-electron-react/)
- [Mac Menu Bar Application with React, TypeScript and Electron (altrim.io)](https://altrim.io/posts/building-mac-menu-bar-app-with-react-typescript-electron)
- [How to securely store sensitive information in Electron with node-keytar (Cameron Nokes)](https://cameronnokes.com/blog/how-to-securely-store-sensitive-information-in-electron-with-node-keytar/)

**Menubar app landscape / UX conventions:**
- [Bartender](https://www.macbartender.com/) — reference for menubar management UX
- [Managing Your Mac Menu Bar: Bartender Alternatives (MacStories)](https://www.macstories.net/roundups/managing-your-mac-menu-bar-a-roundup-of-my-favorite-bartender-alternatives/)
- [Escaping the notch: Tailscale's new macOS home](https://tailscale.com/blog/macos-notch-escape) — signed menubar daemon reference

**Obsidian plugin APIs:**
- [Obsidian Plugins: Markdown post processing](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing)
- [Obsidian Reference: registerMarkdownPostProcessor](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerMarkdownPostProcessor)
- [obsidianmd/obsidian-api (TypeScript typings)](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [Obsidian: Status bar](https://docs.obsidian.md/Plugins/User+interface/Status+bar)
- [Obsidian Forum: Make HTTP requests from plugins (requestUrl vs fetch)](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)
- [Obsidian Forum: CORS problem with library](https://forum.obsidian.md/t/cors-problem-with-library/26703)

**Obsidian plugin patterns (concrete reference implementations):**
- [Syncthing Status Icon (Obsidian plugin)](https://github.com/Diego-Viero/Syncthing-status-icon-Obsidian-plugin) — polls localhost daemon, status bar indicator
- [obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) — HTTP bridge pattern (inverse direction — external→Obsidian — but useful reference for 127.0.0.1 binding)
- [obsidian-plugin-python-bridge](https://github.com/mathe00/obsidian-plugin-python-bridge) — another localhost-daemon-plus-Obsidian-plugin reference
- [obsidian-execute-code](https://github.com/twibiral/obsidian-execute-code) — reference for in-note action buttons injected via post-processor

**Project-internal:**
- `/Users/marcpanu/CodeRepos/PlaudNoteTaker/.planning/PROJECT.md` — authoritative scope and out-of-scope list
- `/Users/marcpanu/CodeRepos/PlaudNoteTaker/.planning/codebase/CONCERNS.md` (referenced via PROJECT.md) — known pipeline issues to surface in Logs tab

---
*Feature research for: macOS menubar utility app + Obsidian action-button plugin, wrapping an existing CLI pipeline*
*Researched: 2026-04-16*
