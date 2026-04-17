# Stack Research

**Domain:** macOS menubar Electron app (signed + notarized) + Obsidian plugin, reusing an existing Node 18+/TypeScript/ESM pipeline with a prebuilt native addon (`@picovoice/eagle-node` 3.0) and a bundled `ffmpeg` binary
**Researched:** 2026-04-16
**Confidence:** HIGH overall. The one genuinely load-bearing unknown is whether `pv_eagle.node` loads inside the Electron 41 main process without rebuild — addressed in "Version Compatibility" and the phase-1 smoke test below. Everything else is direct doc/npm/source-inspection verification.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **Electron** | `^41.2.0` (current stable; `40.x` is the conservative fallback — see Version Compatibility) | App shell. Runs existing `src/*.ts` pipeline in the main process, provides Tray/BrowserWindow/safeStorage/Notifications APIs. | Only Electron lets us run `@picovoice/eagle-node`'s prebuilt `.node` addon in-process; Tauri can't (no Node in main). Electron 41 (Apr 2026) ships Node 24.14 / Chromium 146 / V8 14.6; Electron 40 ships Node 24.11 / Chromium 144. Both support every Node-API version Eagle could target. Electron releases every 8 weeks; latest 3 stable majors (39/40/41) are supported. ([Electron 41 blog](https://www.electronjs.org/blog/electron-41-0), [Electron 40 blog](https://www.electronjs.org/blog/electron-40-0), [Electron release timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)) — **HIGH** |
| **Electron Forge** | `^7.x` (latest) | Build/package/sign/notarize/make pipeline. | Official Electron tool maintained by the Electron team; wraps `@electron/packager` + `@electron/osx-sign` + `@electron/notarize`. First-party support for hardened runtime, universal (arm64+x64) macOS builds, ASAR integrity, and `notarytool` out of the box. New Electron features (e.g. ASAR integrity, universal builds) land here first. ([Why Electron Forge](https://www.electronforge.io/core-concepts/why-electron-forge), [Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos), [Notarize with Forge](https://httptoolkit.com/blog/notarizing-electron-apps-with-electron-forge/)) — **HIGH** |
| **electron-vite** | `^3.x` | Build tooling for main + preload + renderer with HMR and TypeScript out of the box. | Only Electron-native build tool with fast HMR in both main and renderer + native addon re-export handling. v3 supports React/Vue/Svelte/vanilla templates. Plays well with Forge's Vite plugin. ([electron-vite docs](https://electron-vite.org/), [electron-vite-react](https://github.com/electron-vite/electron-vite-react)) — **HIGH** |
| **TypeScript** | `^6.0.2` (already in repo) | Shared language for main, preload, renderer, and the Obsidian plugin. | Already the repo's language; Obsidian's official plugin API ships as TS definitions. No reason to introduce another language. — **HIGH** |
| **Node.js** | `22.x` LTS *for development tooling*; **runtime is Electron's bundled Node 24** | Dev shell + CLI path must still work on plain Node. | Electron 41 bundles Node 24.14.0, so any ESM/async/fetch features from that version are available in the main process. Keeping a Node 22 LTS dev shell avoids accidentally shipping Node-25-only syntax that would need bundling. ([Electron 41 blog](https://www.electronjs.org/blog/electron-41-0)) — **HIGH** |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **`@electron/rebuild`** | `^4.x` (latest) | Rebuild native Node addons against Electron's Node ABI when needed. | Wire it as a `postinstall` script for safety, but expect it to be a no-op for Eagle: `@picovoice/eagle-node` ships as prebuilt `pv_eagle.node` files with **no C source in the npm package**, so rebuild-from-source isn't possible. Keep `@electron/rebuild` present so any *future* native dep (e.g. `better-sqlite3`) Just Works. ([electron/rebuild](https://github.com/electron/rebuild)) — **HIGH** |
| **`@picovoice/eagle-node`** | `^3.0.0` (already pinned) | Speaker recognition — unchanged. | Keep existing dep. Inspection of `node_modules/@picovoice/eagle-node`: ships `lib/mac/arm64/pv_eagle.node` (440 KB) and `lib/mac/x86_64/pv_eagle.node` (449 KB), loaded via `require(libraryPath)`. Single binary for all Node 18+ versions in devDeps → almost certainly **Node-API (N-API)**, which is ABI-stable across Node major versions *and* across Electron's Node runtime. No rebuild flag expected; validate with a 20-line smoke test in phase 1. ([Eagle Node.js API](https://picovoice.ai/docs/api/eagle-nodejs/), [Node-API docs](https://nodejs.org/api/n-api.html), [node-addon-api](https://github.com/nodejs/node-addon-api)) — **MEDIUM** (confidence is MEDIUM only because Picovoice doesn't publish an Electron compatibility statement; the architecture makes it essentially certain but a smoke test is mandatory — see Version Compatibility) |
| **`@napi-rs/keyring`** | `^1.2.0` | Write API keys to the actual macOS Keychain (not just Chromium's encrypted blob). | Preferred over the deprecated `keytar` (archived since Dec 2022, `atom/node-keytar`), and preferred over Electron `safeStorage` **when the requirement is "values readable in Keychain Access.app with the standard system prompt"**. Rust-based, prebuilt binaries, actively maintained, compatible with Electron's Node-API runtime, recently picked up by Microsoft's msal-node / Azure SDK teams as their keytar replacement. ([@napi-rs/keyring npm](https://www.npmjs.com/package/@napi-rs/keyring), [Brooooooklyn/keyring-node](https://github.com/Brooooooklyn/keyring-node), [Azure SDK migration issue](https://github.com/Azure/azure-sdk-for-js/issues/29288)) — **HIGH** |
| **Electron `safeStorage`** | Built-in (Electron 15+) | **Fallback** / alternative for encrypting the Keychain-backed blob. | Built-in, zero dependencies, uses macOS Keychain under the hood *to derive an encryption key*, then AES-encrypts blobs you store yourself (usually via `electron-store`). Simpler than `@napi-rs/keyring` but the secrets are not individually browsable in Keychain Access; there's also a known gotcha where the Keychain service name is `"Chromium Safe Storage"` unless `app.setName()` is called before any `BrowserWindow` is created. ([safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage), [bug #45328](https://github.com/electron/electron/issues/45328)) — **HIGH** — pick one or the other; don't layer both. |
| **`electron-store`** | `^10.x` | JSON persistence for the *app's* config (poll interval, vault path, selected template, etc. — things that are **not secrets**). | Standard choice; handles atomic writes, schema, migrations. Existing `data/*.json` state files can keep their current shape and just move to `app.getPath('userData')` (i.e. `~/Library/Application Support/PlaudNoteTaker/`). ([electron-store on npm](https://www.npmjs.com/package/electron-store)) — **HIGH** |
| **Hono** | `^4.x` | HTTP server for the `127.0.0.1` bridge consumed by the Obsidian plugin. | Tiny (~15 KB), zero-dep, standard `fetch`-style Request/Response, first-class TypeScript, runs on Node's built-in `http` via `@hono/node-server`. For a 1–3 endpoint bridge (`POST /label`, `GET /status`, `GET /notes/recent`) this is all upside vs Express/Fastify — no middleware ecosystem baggage and `hc` gives you type-safe client bindings the Obsidian plugin can import directly. ([hono.dev](https://hono.dev)) — **HIGH** |
| **`ffmpeg-static`** | `^5.x` | Bundled ffmpeg binary shipped inside the `.app`. | Wraps `eugeneware/ffmpeg-static`; provides macOS arm64 + x86_64 prebuilt statically-linked ffmpeg binaries sourced from reputable build servers. `ffmpeg-static` exports a path string — perfect drop-in for the existing `execFile('ffmpeg', ...)` shell-out in `src/audio.ts`. Add to `extraResources`/`asarUnpack` so the binary survives ASAR packaging. ([ffmpeg-static on npm](https://www.npmjs.com/package/ffmpeg-static)) — **HIGH** (with licensing caveats — see "What NOT to Use") |
| **`menubar`** | `^9.5.2` (Oct 2025) | Optional thin wrapper over Tray + BrowserWindow for macOS menubar popover behavior. | Still maintained, 36 dependents, current Electron compat. Handles Tray icon, positioning under the icon, show/hide on blur, double-click vs right-click menu. For Sequoia (macOS 15) and Tahoe (macOS 26) the raw `Tray` + `BrowserWindow({type: 'panel', vibrancy: 'under-window'})` pattern also works and gives finer control over vibrancy/translucency. **Recommendation:** start with `menubar` for speed; if you need custom behavior (drag-detach, multi-screen corner cases) drop to raw Tray. ([menubar on npm](https://www.npmjs.com/package/menubar)) — **HIGH** |
| **`electron-log`** | `^5.x` | Surface pipeline `log()` output in the Logs tab and persist to `userData/logs/`. | Maps cleanly onto the existing `src/log.ts` calls, adds file rotation + IPC-to-renderer streaming. Low-ceremony. ([electron-log](https://github.com/megahertz/electron-log)) — **MEDIUM** (nice-to-have; you could also pipe `console.*` through an `ipcMain.send` yourself) |
| **React 19 + Vite** *(or* **vanilla + Vite***)* | React `^19.x`, Vite `^6.x` | Renderer UI for the popover, Settings, and Logs windows. | The UI is small (recent notes list, settings form, logs tail, speaker list) — React is overkill but ships the most `shadcn/ui`-style component ecosystem for a small polished popover, and `electron-vite` has a ready React template. **If you want to stay minimal, vanilla TS + Vite + a small CSS framework (Pico.css or Tailwind) is a legitimate alternative** and keeps the renderer under 50 KB. — **MEDIUM** (architectural taste call; either works) |
| **Obsidian plugin API types** | `obsidian` latest | TypeScript definitions for the Obsidian plugin. | The one and only official API surface; ships as `obsidian.d.ts`. Use `Plugin.registerMarkdownPostProcessor()` to render the "Match speakers" button inside notes containing the Unknown Speakers callout, and the `requestUrl()` API to call the menubar app's HTTP bridge — see **Version Compatibility** for why you MUST use `requestUrl`, not `fetch`. ([obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin), [registerMarkdownPostProcessor](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerMarkdownPostProcessor), [requestUrl API](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)) — **HIGH** |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| **Electron Forge with Vite template** | Project scaffold, dev server, build, package, make, publish | `npm init electron-app@latest plaud-menubar -- --template=vite-typescript`. Gives you `make`, `package`, `start` scripts; Forge config in `forge.config.ts`. |
| **`@electron/notarize`** | Notarization via `notarytool` (the only option supported by Apple after Nov 2023) | Used transparently by Forge's `@electron/osx-sign` maker. You provide `appleId` + `appleIdPassword` (app-specific password) + `teamId` via env vars. `notarytool` is built into Xcode 13+. ([@electron/notarize](https://github.com/electron/notarize)) |
| **`@electron/osx-sign`** | Hardened runtime signing + entitlements | Used by Forge. Your entitlements plist needs `com.apple.security.cs.allow-jit` (for Electron/V8) and *should NOT* have `com.apple.security.cs.allow-unsigned-executable-memory` — that entitlement was required on Electron ≤11 but is actively harmful on Electron 12+. ([Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)) |
| **esbuild** | Bundler for the Obsidian plugin | Exactly what `obsidianmd/obsidian-sample-plugin` ships in `esbuild.config.mjs` (last updated Dec 2025). No need to deviate — this is the idiomatic path and the community plugin review expects it. |
| **`node-abi`** | Lookup table: Electron version → Node ABI | Reference only. Electron 41 = ABI 145, Electron 40 = ABI 143. Not needed for Eagle (N-API), but useful if you ever add a non-N-API native dep. ([electron/node-abi](https://github.com/electron/node-abi)) |
| **`electron-builder`** | **Alternative** packager (not recommended for this project — see below) | Kept here only to explain the decision. |

---

## Installation

```bash
# One-time: scaffold the Electron app alongside the existing repo
#   (or in a new workspace; see ARCHITECTURE.md for monorepo vs. sibling decision)
npm init electron-app@latest plaud-menubar -- --template=vite-typescript

# Core runtime deps for the Electron app
npm install \
  hono @hono/node-server \
  @napi-rs/keyring \
  electron-store \
  electron-log \
  ffmpeg-static \
  menubar

# Keep the existing pipeline deps — they're already in package.json
# @picovoice/eagle-node@^3.0.0  — NO CHANGE
# dotenv@^17.4.2                — keep for the CLI path; the Electron app reads Keychain instead

# Build/sign/notarize deps (Forge installs most of these itself; listed for clarity)
npm install -D \
  @electron-forge/cli \
  @electron-forge/maker-dmg \
  @electron-forge/maker-zip \
  @electron-forge/plugin-vite \
  @electron/rebuild \
  electron@^41.2.0

# Obsidian plugin (separate workspace)
npm install -D obsidian esbuild typescript
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| **Electron Forge** | `electron-builder` | If you need DMG custom backgrounds/layouts out of the box, auto-update infrastructure with GitHub Releases, or already have a working electron-builder config. For **this** single-user, no-auto-update, signed-DMG-only milestone, Forge's first-party signing + notarization path is strictly simpler. |
| **`@napi-rs/keyring`** | Electron `safeStorage` + `electron-store` | If you want zero native-addon surface area and are OK with secrets stored as AES-encrypted blobs instead of individual Keychain items. Perfectly secure; just less transparent to the user. |
| **Hono** | Node's built-in `http` | For literally 1 endpoint and zero growth, raw `http.createServer((req,res)=>…)` is 20 lines. Hono's value shows up on request #2 (body parsing, routing, type-safe client for the plugin). |
| **Hono** | Fastify 5.x | Fastify is production-excellent but ~3x the bundle size and heavier plugin ecosystem you won't use on localhost:NNNN with no auth. |
| **Hono** | `electron-trpc` / tRPC | tRPC would be great if the Obsidian plugin were part of the same monorepo with shared types. It's not (plugins install independently from GitHub), so the type-sharing benefit is mostly lost and you'd pay tRPC's complexity cost for nothing. |
| **`menubar` package** | Raw `Tray` + `BrowserWindow({type:'panel'})` | Go raw if you need drag-to-detach, non-standard positioning, or macOS 15+ vibrancy effects beyond what `menubar` exposes. For Fantastical/Things-style behavior, `menubar` covers it. |
| **React + Vite** | Svelte 5 or vanilla TS + Vite | Svelte gives smaller bundles and ergonomic reactivity for this small UI. Vanilla TS is the absolute minimal path (~30 KB). Pick based on your comfort; React has the most copy-pasteable Electron boilerplate. |
| **`ffmpeg-static`** | Build universal ffmpeg binary locally (e.g. Martin Riedl's builder) | If you need codec combinations `ffmpeg-static` doesn't include, or you want control over which LGPL/GPL components are linked. For straight `ogg → wav` conversion, `ffmpeg-static` has everything you need. |
| **`electron-vite`** | Webpack-based Forge template | Webpack is the Forge default template; it works but is slower and more config-heavy. `electron-vite` is the 2026 standard. |
| **No auto-update (current decision)** | `update-electron-app` (a.k.a. `electron-updater` wrapping Squirrel.Mac) | If in a later milestone you open this to more users, `update-electron-app` + a static S3/GitHub Releases feed is the minimum-infrastructure path. For v1 single-user, skip. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| **`keytar` / `node-keytar`** | Archived by GitHub in Dec 2022 ("deprecated, unmaintained"). No longer gets prebuilt binaries for new Node or Electron ABIs. Already causing problems on recent Electron majors. | `@napi-rs/keyring` (1-for-1 API replacement) **or** Electron `safeStorage`. ([atom/node-keytar readme](https://github.com/atom/node-keytar), [VS Code's migration](https://github.com/microsoft/vscode/issues/185677)) |
| **`electron-builder` for *this* milestone** | Known flaky notarization path (documented in Forge's own "Why Forge?" page and in multiple postmortems); you'd disable the built-in notarize and shell out to `@electron/notarize` via `afterSign` anyway. For a single-user app with no auto-update, every feature electron-builder is better at is unused. | `Electron Forge` + Vite plugin. |
| **`electron-rebuild` (the old package)** | Deprecated; replaced by `@electron/rebuild` under the official `electron/` GitHub org. | `@electron/rebuild` (note the scope). |
| **`ffi-napi` / `node-ffi-napi`** for loading `libpv_eagle.dylib` directly | `ffi-napi` does not work on Electron 21+ due to the V8 memory cage; `koffi` works but adding FFI for a library that already ships prebuilt `.node` addons is pure self-harm. | Use the `@picovoice/eagle-node` package as-is; `pv_eagle.node` is already a valid Node-API addon and loads through `require()`. |
| **`node-pre-gyp` / `prebuild-install` as runtime deps** | Only relevant if *you* are the one shipping a native module. `@picovoice/eagle-node` does not use either; it ships binaries directly. | Nothing — just `require('@picovoice/eagle-node')`. |
| **Legacy `altool` for notarization** | Apple disabled `altool` for notarization on Nov 1, 2023. Any blog post older than 2024 suggesting `xcrun altool --notarize-app` is stale. | `xcrun notarytool` (Xcode 13+), invoked by `@electron/notarize`. |
| **`com.apple.security.cs.allow-unsigned-executable-memory` entitlement** | Required on Electron ≤11; actively harmful on Electron 12+ — weakens hardened runtime protection. Still appears in old copy-pasted entitlements.plist files. | Use `com.apple.security.cs.allow-jit` only. For ffmpeg shell-outs, you also need `com.apple.security.cs.disable-library-validation` **only if ffmpeg dynamically loads plugins** — the static `ffmpeg-static` binary doesn't, so you likely don't need it. |
| **`fetch()` in the Obsidian plugin** | Obsidian renderer runs in `app://obsidian.md` origin; `fetch()` to `http://127.0.0.1:NNNN` will fail CORS. | Obsidian's built-in `requestUrl()` API — explicitly designed for this, bypasses CORS, available since Obsidian 0.12.11. ([Obsidian forum post](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)) |
| **`app.setLoginItemSettings({openAtLogin: true})` alone on macOS 13+** | Still works for Developer-ID-signed (non-MAS) apps, but on macOS 13+ Apple's `SMAppService` is the modern API. Electron 28+ exposes `ServiceType: 'mainAppService'` which uses `SMAppService` under the hood when set. | `app.setLoginItemSettings({openAtLogin: true, type: 'mainAppService', serviceName: 'com.marcpanu.plaudnotetaker'})` on macOS 13+, with a graceful fallback for older macOS (won't apply in practice — target is likely Sequoia/Tahoe only). ([Electron app API](https://www.electronjs.org/docs/latest/api/app)) |
| **Mac App Store distribution** | Sandbox forbids child-process shell-out to ffmpeg and writing outside the sandbox to the Obsidian vault. Already explicitly out of scope per `PROJECT.md`. | Developer ID signing + notarization for direct distribution (also already the plan). |
| **`auto-launch` npm package** | Abandoned (no release since 2019). Writes a `plist` into `~/Library/LaunchAgents/` which doesn't play well with notarized apps or SMAppService. | `app.setLoginItemSettings()` (Electron built-in). |
| **Auto-update via `update-electron-app`** | Not wrong — just unused. Requires GitHub Releases or S3 feed infrastructure for a single user. Kept out per `PROJECT.md`. | Drag-and-drop reinstall. |

---

## Stack Patterns by Variant

**If you want the lowest-friction path to a shipped signed app:**
- Electron Forge + Vite template
- `menubar` npm package (don't roll your own Tray positioning)
- Electron `safeStorage` (no native Keychain dep)
- Hono for the bridge
- Vanilla TS + Vite for the renderer (no framework)
- **Why:** every choice is "what the Electron team actually ships" — shortest distance between scaffold and notarized DMG.

**If you want native-macOS-feel first:**
- Raw `Tray` + `BrowserWindow({type:'panel', vibrancy:'under-window', visualEffectState:'active'})` (skip `menubar` wrapper)
- `@napi-rs/keyring` (so API keys appear in Keychain Access.app like any other native macOS secret)
- `SMAppService` via `app.setLoginItemSettings({type: 'mainAppService', ...})`
- `app.dock.hide()` so the app truly is menubar-only
- **Why:** trades ~2 days of extra Tray/vibrancy work for Sequoia/Tahoe-native polish.

**If the Obsidian plugin grows (second milestone, more endpoints):**
- Add `zod` for request validation on the Hono side; re-export the Zod schemas from a shared `@plaud/bridge-types` tiny package
- Consider `@hono/client` (`hc<AppType>`) — gives the plugin typed `client.label.$post({json: {notePath}})` calls
- **Why:** Hono's type-safe client makes the bridge feel like tRPC without the tRPC dependency, as long as both ends can import a shared TS types file.

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `electron@^41.2.0` | `@picovoice/eagle-node@^3.0.0` prebuilt `pv_eagle.node` | **EXPECTED COMPATIBLE, UNVERIFIED IN ELECTRON SPECIFICALLY.** Reasoning: Eagle ships one `.node` per OS/arch (no Node-version variants), the same binary works across Node 18/20/22/24 per the package's devDependencies and engines field (`"node": ">=18.0.0"`) — only Node-API addons exhibit that property. Electron 41's Node 24.14 supports Node-API up to v10. **MANDATORY SMOKE TEST (phase 1, ~20 lines):** scaffold an empty Forge app, add `@picovoice/eagle-node`, `const { EagleProfiler } = require('@picovoice/eagle-node')` in main, instantiate with a test AccessKey, log `eagle.version`. If this throws with `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` complaints, fall back to **Electron 40.x** (Node 24.11, Chromium 144) — same Node major, same Node-API surface, proven slightly longer. If Electron 40 also fails, the cause is almost certainly `asar` packaging hiding the `.node` file, fixed via `asarUnpack` in Forge config, NOT an ABI issue. Picovoice has not published an Electron support matrix. ([Node-API docs](https://nodejs.org/api/n-api.html), [Electron 41 blog](https://www.electronjs.org/blog/electron-41-0)) |
| `electron@^41.2.0` | `@napi-rs/keyring@^1.2.0` | HIGH — `@napi-rs/keyring` is a Node-API 8+ addon, prebuilt for `darwin-arm64` and `darwin-x64`. Works in Electron main process without rebuild. |
| `electron@^41.2.0` | `@electron/rebuild@^4.x` | HIGH — latest `@electron/rebuild` tracks latest Electron ABIs. |
| `electron@^41.2.0` | `menubar@^9.5.2` | HIGH — `menubar` uses only stable Electron APIs (Tray, BrowserWindow, app lifecycle); last publish Oct 2025, no breaking changes in Electron 40/41. |
| `electron@^41.2.0` | `ffmpeg-static@^5.x` | HIGH — `ffmpeg-static` just ships a binary; no Electron coupling. Needs to be declared in Forge's `packagerConfig.extraResource` or listed in `asarUnpack` so it survives packaging. |
| `electron@^41.2.0` | `hono@^4.x` + `@hono/node-server@^1.x` | HIGH — pure JS, no native deps, runs on Node's `http` module. |
| Electron 41 Node ABI | 145 | Reference only — not needed for N-API addons. |
| Electron 40 Node ABI | 143 | Conservative fallback target. |
| Obsidian API | `requestUrl()` API | Available since Obsidian 0.12.11 (early 2022) — effectively always available. Use instead of `fetch()` to avoid CORS. |
| `ffmpeg-static` | macOS notarization | `ffmpeg-static`'s macOS arm64 and x64 binaries ARE NOT code-signed by the ffmpeg-static project. You **must** re-sign them as part of your Electron build — Forge's `osxSign` with `identity` set handles this automatically when the binary is inside the `.app` bundle (`--deep` flag). Re-sign with your Developer ID; notarize the whole `.app`. This is a well-known step, not a blocker. |
| `ffmpeg-static` LGPL | Developer ID redistribution | `ffmpeg-static` ships statically-linked ffmpeg with LGPL components. Redistribution is legal provided (a) you mention ffmpeg in the app's credits/acknowledgments, (b) you include the LGPL license text (ship in `Resources/`), and (c) you don't include `--enable-gpl` or `--enable-nonfree` components. `ffmpeg-static` by default uses an LGPL-clean build. For a single-user non-commercial app the practical risk is ~zero; document the attribution in the About window or a bundled NOTICE file. |

---

## Sources

### Primary (HIGH confidence)
- **Direct source inspection** — `node_modules/@picovoice/eagle-node/package.json`, `src/platforms.ts`, `src/eagle.ts`, and the actual `lib/mac/{arm64,x86_64}/pv_eagle.node` files on disk. Confirms prebuilt N-API `.node` addons, no C source in package, `require(libraryPath)` loading mechanism.
- [Electron 41.0.0 release blog](https://www.electronjs.org/blog/electron-41-0) — Node 24.14, Chromium 146, V8 14.6 (April 2026)
- [Electron 40.0.0 release blog](https://www.electronjs.org/blog/electron-40-0) — Node 24.11, Chromium 144
- [Electron Release Timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) — 8-week cadence, latest 3 majors supported
- [Electron release schedule](https://releases.electronjs.org/schedule) — current stable via npm is 41.2.0 (Apr 2026)
- [Electron Forge: Why Electron Forge](https://www.electronforge.io/core-concepts/why-electron-forge) — first-party tool rationale
- [Electron Forge: Signing a macOS app](https://www.electronforge.io/guides/code-signing/code-signing-macos) — current macOS signing guide
- [Electron `app` API](https://www.electronjs.org/docs/latest/api/app) — `setLoginItemSettings` service types (macOS 13+)
- [Electron `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) — Keychain-backed key storage
- [Electron code signing docs](https://www.electronjs.org/docs/latest/tutorial/code-signing) — hardened runtime + notarization reference
- [Electron native modules tutorial](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) — `@electron/rebuild` usage
- [Node-API docs](https://nodejs.org/api/n-api.html) — ABI stability guarantees
- [Node-API version matrix](https://github.com/nodejs/abi-stable-node) — N-API / Node / Electron mapping
- [@electron/notarize](https://github.com/electron/notarize) — `notarytool`-based notarization, required since Apple deprecated `altool` in Nov 2023
- [@napi-rs/keyring npm](https://www.npmjs.com/package/@napi-rs/keyring) — maintained keytar replacement
- [Brooooooklyn/keyring-node](https://github.com/Brooooooklyn/keyring-node) — implementation
- [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) — official plugin template (updated Dec 2025)
- [registerMarkdownPostProcessor docs](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerMarkdownPostProcessor) — the API to inject the "Match speakers" button
- [menubar on npm](https://www.npmjs.com/package/menubar) — v9.5.2, Oct 2025
- [Hono docs](https://hono.dev/) — HTTP server framework
- [@picovoice/eagle-node npm](https://www.npmjs.com/package/@picovoice/eagle-node) — package metadata
- [Picovoice Eagle Node.js API](https://picovoice.ai/docs/api/eagle-nodejs/) — public API surface

### Secondary (MEDIUM confidence)
- [Azure SDK migration issue](https://github.com/Azure/azure-sdk-for-js/issues/29288) — corroborates @napi-rs/keyring as the industry keytar replacement
- [VS Code move off keytar](https://github.com/microsoft/vscode/issues/185677) — corroborates keytar deprecation and safeStorage direction
- [HTTPToolkit: Notarize with Forge](https://httptoolkit.com/blog/notarizing-electron-apps-with-electron-forge/) — practical Forge + notarize walkthrough
- [Obsidian forum: make HTTP requests from plugins](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461) — `requestUrl` vs `fetch` CORS confirmation
- [Freek Van der Herten: replacing keytar with safeStorage](https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray) — migration pattern
- [ffmpeg-static on npm](https://www.npmjs.com/package/ffmpeg-static) — package metadata
- [Martin Riedl FFmpeg builds](https://ffmpeg.martin-riedl.de/) — signed/notarized ffmpeg binary source (backup option)

### Not verified (LOW confidence — flagged for phase-1 smoke test)
- **Eagle 3.0's `pv_eagle.node` loads in Electron 41 without rebuild.** Architecturally essentially certain (Node-API, single binary for all Node 18+ versions), but Picovoice has never published an Electron compatibility statement. The entire "Electron over Tauri" decision in `PROJECT.md` rests on this. 20-line smoke test in phase 1 is mandatory, not optional. If it fails in Electron 41, drop to Electron 40 before doing anything else.

---
*Stack research for: macOS menubar Electron app + Obsidian plugin (PlaudNoteTaker Electron milestone)*
*Researched: 2026-04-16*
