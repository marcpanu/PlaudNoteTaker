# Pitfalls Research

**Domain:** Signed + notarized macOS Electron menubar app that bundles a native Node module (`@picovoice/eagle-node`) and an external binary (ffmpeg), runs a background poll loop, exposes a loopback HTTP server, and pairs with an Obsidian plugin. Single user, macOS only (Sequoia 15 / macOS 16 era).
**Researched:** 2026-04-16
**Confidence:** HIGH for native module rebuild / notarization entitlements / safeStorage / `requestUrl` (Context7-equivalent official docs, multiple corroborating bug trackers). MEDIUM for the more speculative interaction effects (e.g., `powerMonitor resume` ↔ poll-loop reseeding, first-run atomic migration). LOW for unverified claims flagged inline.

---

## Critical Pitfalls

### Pitfall 1: Eagle native module ABI mismatch — `NODE_MODULE_VERSION` crash at first run of the packaged app

**What goes wrong:**
`@picovoice/eagle-node` ships prebuilt `.node` binaries compiled against the system's Node.js ABI. Electron uses a different ABI (Chromium's BoringSSL, different V8 version, different `NODE_MODULE_VERSION`), so the prebuild that `npm install` downloads will crash the main process on the first `require('@picovoice/eagle-node')` with:

```
Error: The module '<path>/eagle.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION $XYZ. This version of Node.js requires NODE_MODULE_VERSION $ABC.
Please try re-compiling or re-installing the module (for instance, using `npm rebuild` or `npm install`).
```

The CLI keeps working (it uses system Node), so this is invisible until you actually launch the packaged `.app`. In the worst case, it only surfaces when Eagle is first invoked during a real poll cycle, so you can even miss it during a "does the menubar icon appear" smoke test.

**Why it happens:**
Three compounding reasons:
1. Eagle is a prebuild-powered module — `npm install` prefers downloading a binary over compiling, so `@electron/rebuild` is the only thing that forces the right ABI.
2. Developers remember to run `electron-rebuild` once by hand, then forget to wire it into `postinstall`, so CI / fresh clones break.
3. The error only fires when `Eagle` is actually constructed, not when the app starts, so a CI "app launches" smoke test passes.

**How to avoid:**
- Pin Electron in `devDependencies` (exact version, not `^`) — `@electron/rebuild` infers the ABI from this.
- Add to `package.json`:
  ```json
  "scripts": {
    "postinstall": "electron-rebuild -f -w @picovoice/eagle-node"
  }
  ```
  The `-f` forces rebuild even if a prebuild exists; `-w` scopes it so other deps aren't rebuilt unnecessarily.
- Add an Eagle smoke test to `electron-builder`'s `beforeBuild` hook that constructs and destroys an `Eagle` instance inside an Electron-spawned Node context. Fail the build if it throws.
- Document Node version requirement: `@electron/rebuild` ≥ latest requires **Node ≥ 22.12**. Mismatch here causes silent "rebuild" that actually does nothing.
- If `eagle-node` ever ships its own universal (arm64 + x64) binary, that doesn't help — it's still the wrong ABI. Rebuild is non-negotiable.

**Warning signs:**
- `require('@picovoice/eagle-node')` throws immediately on module load (not on `new Eagle(...)`).
- `codesign --verify --deep --strict <app>` succeeds but the app crashes on first Eagle use.
- Stack trace mentions `process.versions.modules` mismatch.
- Works in `npm run dev` but not in the packaged `.app` (dev uses system Node; packaged uses Electron's Node).

**Phase to address:**
Earliest Electron-scaffold phase (the one that first does `npm install electron` and tries to `require` existing `src/*.ts`). This must be solved before any further work — otherwise every subsequent phase is building on a broken foundation.

---

### Pitfall 2: ffmpeg binary fails notarization because it's not individually signed with hardened runtime

**What goes wrong:**
You add `ffmpeg` to `extraResources`, the app signs fine (`codesign --verify` passes on the `.app`), the DMG uploads to `notarytool`, then notarization **fails** with a log like:

```
"severity": "error",
"code": null,
"path": "PlaudNoteTaker.app/Contents/Resources/ffmpeg",
"message": "The binary is not signed with a valid Developer ID certificate.",
"docUrl": "https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution/resolving-common-notarization-issues"
```

Or, if it does notarize, it crashes at runtime with `killed: 9` / SIGKILL the moment the Electron main process tries to `spawn()` it — Gatekeeper kills unsigned helper binaries on launch.

**Why it happens:**
- `codesign --deep` is [widely considered an anti-pattern](https://developer.apple.com/forums/thread/121422) and electron-builder's default signer doesn't recursively sign arbitrary binaries under `Contents/Resources/` — only the standard Electron helpers.
- Every embedded executable must be individually signed with `--options=runtime` (hardened runtime) and a Developer ID Application certificate.
- `ffmpeg-static` ships a stripped-down ffmpeg that's NOT signed. Some prebuilt distributions (e.g., the Martin Riedl builds) are already signed+notarized, but the hashes change per version and you can't rely on re-signing working transparently.
- Command-line binaries **cannot be stapled** (Apple's own docs), so the signed ffmpeg must rely on being embedded inside a stapled `.app` bundle — it inherits the bundle's notarization only if codesign is done correctly.

**How to avoid:**
- Pick ONE source of the ffmpeg binary and pin it. Options:
  1. `ffmpeg-static` npm package — tiny, simple, but you must sign it yourself.
  2. A custom universal ffmpeg built from source with the codecs you actually need (lighter, but a build project of its own).
  3. Martin Riedl's pre-notarized ffmpeg — already signed, but re-signing with your Developer ID is safer and deterministic.
- Set `extraResources` to copy `ffmpeg` (and `ffprobe` if used) into `Contents/Resources/bin/`, NOT into `app.asar`.
- In `electron-builder` config, set `asarUnpack` for anything you `spawn`, because `child_process.spawn` cannot execute from inside asar archives.
- Implement an `afterSign` hook (runs BEFORE notarization) that calls `codesign` explicitly for each bundled binary:
  ```js
  // afterSign.js
  const { execSync } = require('child_process');
  module.exports = async function(context) {
    const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
    const identity = process.env.APPLE_DEVELOPER_ID; // "Developer ID Application: Name (TEAMID)"
    const binaries = [
      `${appPath}/Contents/Resources/bin/ffmpeg`,
      // add ffprobe etc. if bundled
    ];
    for (const bin of binaries) {
      execSync(
        `codesign --force --options=runtime --timestamp --sign "${identity}" "${bin}"`,
        { stdio: 'inherit' }
      );
    }
  };
  ```
  Reference it from electron-builder's `afterSign` config.
- After the build, verify:
  ```bash
  codesign --verify --deep --strict --verbose=4 <app>
  codesign -dv --entitlements :- <app>/Contents/Resources/bin/ffmpeg
  ```
- Architecture check: `ffmpeg-static` ships an **x64 binary**. On an Apple Silicon Mac, this forces the app (or at least the spawned process) through Rosetta, and notarization flags processes running under translation. Ship an arm64 or universal ffmpeg. Verify with `lipo -archs <path-to-ffmpeg>` — should output `arm64 x86_64` (universal) or at least `arm64` for an arm64-only build.

**Warning signs:**
- `notarytool log <submission-id>` output contains "not signed" or "invalid signature" for any path under `Contents/Resources/`.
- Packaged app runs fine in development but first spawn of ffmpeg exits with signal `SIGKILL` and no stderr output.
- `spctl --assess --verbose <app>` reports `source=Unnotarized`.
- Console.app shows "launch constraint violation" or "kill(PID, 9)" from `amfid`.

**Phase to address:**
Packaging / signing phase. Must be addressed the FIRST time the app is notarized — fixing it later means one or more failed uploads to Apple, each of which takes 5–30 minutes to round-trip. Factor this into the packaging phase's estimate; expect at least 2–3 notarization iterations before it's green.

---

### Pitfall 3: Hardened runtime entitlements missing for native node modules → app silently crashes under Gatekeeper

**What goes wrong:**
The app notarizes successfully, opens on your dev Mac fine, but on a fresh install (or after a reboot, or on the user's actual machine) it crashes immediately with a vague "PlaudNoteTaker quit unexpectedly". Crash log in `~/Library/Logs/DiagnosticReports/` blames `amfid` (Apple Mobile File Integrity daemon) or reports:

```
Termination Reason: CODESIGNING, Code Signature Invalid
```

Or, `@picovoice/eagle-node` loads in dev but fails in the signed app with "code signature not valid for use in process" — because Eagle's `.node` binary is signed by a different Team ID (Picovoice's, not yours), and **library validation** blocks it.

**Why it happens:**
Hardened runtime (required for notarization) enforces *library validation* by default: every dylib, framework, and `.node` binary loaded into the process must be signed by the SAME Team ID as the host app. Native node modules from npm are signed by nobody, or signed by the vendor — NEVER by your Team ID.

**How to avoid:**
- Create `build/entitlements.mac.plist` with the full set needed for Electron + native modules:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <!-- Electron's V8 JIT requires these -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <!-- Required because @picovoice/eagle-node is not signed by your Team ID -->
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <!-- Allows dyld environment variables (needed by some native modules) -->
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
  </dict>
  </plist>
  ```
- Create `build/entitlements.mac.inherit.plist` with the same contents (helper processes inherit separately).
- Wire both into `electron-builder.yml` under `mac.entitlements` and `mac.entitlementsInherit`. This is NOT optional — missing `entitlementsInherit` causes helper process crashes that are extremely hard to diagnose.
- Do NOT add `com.apple.security.cs.disable-executable-page-protection` — it's a stronger (worse) variant that's rarely needed and can fail notarization review.

**Warning signs:**
- `Termination Reason: CODESIGNING` in a crash report.
- `amfid` mentioned in Console.app when launching the app.
- App runs in `electron .` dev mode but not in the packaged build.
- `sudo log stream --predicate 'process == "amfid"' --style compact` during app launch shows rejected loads.
- App launches on dev machine but not after clean install via DMG on a second machine.

**Phase to address:**
Packaging / signing phase. Pairs with Pitfall 2 — both fall out of the first successful notarization. Verification is a one-time event: once these entitlements are right, they stay right.

---

### Pitfall 4: `setInterval` poll loop freezes across sleep/wake and doesn't catch up

**What goes wrong:**
The existing CLI uses a `while (true) { await poll(); await sleep(N) }` loop or a `setInterval`. Both survive a terminal session because users don't close their laptop with the CLI running. Moved into a background Electron main process:

1. User closes their laptop lid at 5 PM.
2. macOS suspends the Electron process. `setInterval` pauses.
3. User opens the laptop at 8 AM. The Node event loop resumes.
4. `setInterval` fires ONCE (not 15 catchup times for the missed 15 hours).
5. If the poll loop had any per-iteration state (e.g., an in-flight AssemblyAI `transcriptId`), the timeouts attached to that request have drifted wildly — the app might think transcription has been running 15 hours when actually the HTTP request just reconnected.

Worse: if the poll was mid-HTTP-request when the suspend hit, `fetch()` may throw `ECONNRESET`, `ETIMEDOUT`, or hang forever depending on how macOS decided to tear down the socket. The existing retry logic in `assemblyai.ts` only retries on "Internal server error" (per CONCERNS.md line 48), not on network errors — so the first recording after wake silently fails.

**Why it happens:**
- macOS suspends Node's event loop during sleep; JS timers don't queue up missed ticks, they just don't fire.
- `fetch()` inherits whatever socket state the OS gives back on resume — sometimes clean, sometimes zombie.
- App Nap (macOS's aggressive power saving when the app is hidden) throttles background timers, so even without a sleep/wake cycle, a 60-second `setInterval` can drift by tens of seconds.

**How to avoid:**
- Subscribe to `powerMonitor` in the main process and force an immediate poll on resume:
  ```js
  import { powerMonitor } from 'electron';
  powerMonitor.on('resume', () => {
    log.info('System resumed, forcing immediate poll');
    pollNow();  // cancel any in-flight timer, restart the cycle
  });
  powerMonitor.on('suspend', () => {
    log.info('System suspending, will resume poll on wake');
    abortInFlightRequests();  // AbortController.abort() on pending fetches
  });
  ```
  Note: `resume` fires TWICE on macOS (per electron/electron#24803) — debounce, don't trigger twice.
- Replace `setInterval` with a recursive `setTimeout` pattern so each iteration schedules the next only AFTER the prior one finishes:
  ```js
  async function pollLoop() {
    try { await poll(); } catch (e) { log.error(e); }
    pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
  ```
- Call `app.setActivationPolicy('accessory')` AND request `powerSaveBlocker.start('prevent-app-suspension')` when the poll loop is actively processing a recording (NOT during idle polling — that would prevent normal sleep). Release the blocker when the pipeline is idle.
- Widen the AssemblyAI retry criteria (per CONCERNS.md fix-approach): retry on 5xx status codes AND on network errors (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`), not just on error-text pattern.
- Every `fetch()` in the pipeline must attach an `AbortSignal` tied to a sensible timeout (e.g., 5 min for transcription polling, 30 s for metadata calls). Don't rely on Node's default no-timeout behavior.

**Warning signs:**
- App log shows no activity between laptop-close timestamp and laptop-open timestamp + the full poll interval.
- First poll after wake crashes with `ECONNRESET` or `socket hang up`.
- `processed-recordings.json` has a gap where Plaud definitely delivered new recordings.
- AssemblyAI jobs in "processing" state forever — the app never polled for their completion because the poll loop was suspended.
- User reports "I closed the lid with 1 new recording, opened it 8 hours later, nothing happened until I clicked Poll Now".

**Phase to address:**
Whichever phase moves the poll loop from CLI (`src/cli/start.ts`) into the Electron main process. This is the phase where the new failure modes appear — the existing CLI never hit them because users never suspended mid-loop.

---

### Pitfall 5: First-run state migration corrupts or loses existing user data

**What goes wrong:**
PROJECT.md specifies: "detect existing `.env` + `data/` in the repo directory, import API keys into Keychain, copy state into `~/Library/Application Support/PlaudNoteTaker/`. Old files untouched." This is the single highest-stakes operation in the milestone — the user has ~6 months of `processing-history.json`, enrolled speaker profiles (Eagle serialized `ArrayBuffer`s per commit `8d0a17b`), and processed-ID dedup state. Losing or corrupting any of this is a regression.

Common ways this goes wrong:
1. **Partial migration**: Copy succeeds for 3 of 4 files, then crashes on `speaker-profiles.json` (file lock, permissions, disk full). Now app state is half-migrated and the app will re-process every recording.
2. **Concurrent CLI + app**: User is running `npx tsx src/cli/start.ts` in a terminal while first-launching the app. The CLI is writing to `./data/processed-recordings.json` at the moment the app reads it → partial JSON, parse error, app corrupts its own copy.
3. **Re-migration on every launch**: First-run detection uses "does `~/Library/Application Support/PlaudNoteTaker/` exist?" — but maybe the user deleted the old `./data/` after migration; next launch, the detection code sees no repo-dir data and no new-dir data, creates empty files, and silently starts from scratch.
4. **Symlink / alias confusion**: If `VAULT_PATH` in `.env` was a relative path (`./vault`), importing it literally into the Keychain or settings breaks when the app's cwd is `/Applications/PlaudNoteTaker.app/Contents/MacOS/`, not the repo root.
5. **Eagle profile deserialization**: Per commit `8d0a17b`, Eagle speaker profiles are `ArrayBuffer`s. If the migration reads them as `Buffer` and writes back without preserving the exact byte layout, Eagle's `fromBytes()` silently loads a corrupt profile — future speaker-match calls return nonsense.

**Why it happens:**
- Developers treat "copy files from A to B" as trivial and don't defensively version/checksum/lock.
- The CLI doesn't hold a file lock, so two processes can race.
- "Has it migrated?" is a sentinel question that's easy to answer wrongly.

**How to avoid:**
- Write a dedicated `migrate()` function with these properties:
  1. **Atomic & idempotent**: Copy all files to a `~/Library/Application Support/PlaudNoteTaker/.migration-staging/` directory first. Only on full success, rename the staging dir to the real name. If the rename fails, delete staging and keep the app uninitialized (fail loudly, don't half-migrate).
  2. **Sentinel file, not inferred state**: Write `~/Library/Application Support/PlaudNoteTaker/.migrated-v1` with a timestamp + source path. The "should we migrate?" check is `!fs.existsSync(sentinel)`, not a heuristic.
  3. **Cooperative lock**: Create `~/Library/Application Support/PlaudNoteTaker/.app.lock` (flock) on app start. If it exists and points to a running PID, refuse to start a second instance. This prevents app-vs-app races.
  4. **Repo-dir quarantine**: Before reading `./data/*.json`, check if the CLI is running (look for a lockfile the CLI could leave, or scan `ps aux` for `tsx src/index.ts start`). If detected, refuse to migrate and show a UI message: "The CLI is still running. Quit it with Ctrl-C, then reopen this app."
  5. **Validate after copy**: After each JSON file is copied, parse it. If parse fails, roll back the whole migration (delete staging dir, don't set sentinel).
  6. **Preserve binary buffers exactly**: For `speaker-profiles.json`, read with `fs.readFile(path)` (Buffer), write with the same — don't round-trip through JSON.parse → JSON.stringify unless the serialization format is explicitly documented in `src/speakers/eagle.ts` and uses base64 or similar.
  7. **Resolve paths absolutely**: Any path in `.env` (`VAULT_PATH`, `TEMPLATES_DIR`, etc.) must be resolved to absolute paths relative to the `.env` file's location, not `process.cwd()`.
- Keep `./data/` untouched per PROJECT.md. Never delete, rename, or write to it from the app. If the user wants to reclaim disk, they can `rm` it themselves.
- Log every migration step with before/after byte counts so a post-migration diff is trivially auditable.

**Warning signs:**
- After first launch, the "recent notes" popover shows 0 entries despite the repo having months of `processing-history.json`.
- Eagle speaker recognition returns different results than the CLI did yesterday (profiles corrupted on deserialize).
- App re-downloads and re-transcribes recordings that were already processed (dedup state not migrated).
- `~/Library/Application Support/PlaudNoteTaker/` exists but has 0-byte JSON files (migration crashed mid-write).
- User reports "I opened the app once, closed it, opened again, and it started fresh" (sentinel logic is wrong).

**Phase to address:**
Whichever phase introduces the Application Support directory / onboarding flow. Probably the same phase as Keychain import (they're bundled as "first-run migration"). This phase needs a recovery-path test case: delete `~/Library/Application Support/PlaudNoteTaker/`, ensure next launch re-migrates cleanly; simulate mid-migration crash (kill the process during copy) and verify rollback.

---

### Pitfall 6: Localhost HTTP server doesn't shut down → next app launch crashes with EADDRINUSE

**What goes wrong:**
You implement the loopback HTTP bridge on a fixed port (the canonical choice is something in the dev-range, e.g., 27123 to mimic the Obsidian Local REST API plugin, or a random-ish port like 49123). First time the app runs: server binds, Obsidian plugin works, all green. Then one of:

1. User force-quits the app (Cmd-Q in the middle of a poll). The `before-quit` handler runs but the HTTP server's sockets are still in `TIME_WAIT`. Next launch: `EADDRINUSE: address already in use :::27123` and the app either crashes or silently skips starting the server — and the Obsidian button stops working with no visible error.
2. Crash leaves the port bound until macOS reaps it (up to 2 minutes of `TIME_WAIT`).
3. User has another Electron app also using port 27123 (the Obsidian Local REST API plugin IS on this port by default — collision risk is real).
4. The server binds to `0.0.0.0` instead of `127.0.0.1` by mistake — now it's LAN-accessible, violating the "loopback only" constraint from PROJECT.md.
5. The `will-quit` handler tries to `server.close()` asynchronously, but `event.preventDefault()` was never called, so Electron exits before close completes. Open sockets abort mid-request; a note being written via `/match-speakers` gets partially mutated in the vault.

**Why it happens:**
- `http.Server.close()` is async and waits for in-flight connections to drain, but Electron's `will-quit` handler runs synchronously by default.
- Node's default socket binding is interpreted permissively (binding to `''` or `undefined` listens on all interfaces).
- Fixed ports are a convenience that becomes a liability as soon as any collision exists.

**How to avoid:**
- **Bind explicitly**: `server.listen({ host: '127.0.0.1', port: CONFIGURED_PORT })`. Never omit `host`, never use `0.0.0.0` or `::` or `localhost` (localhost can resolve to IPv6 `::1` on some configs — explicit `127.0.0.1` is safest). Test that `curl http://<your-LAN-ip>:<port>/health` gets `Connection refused`.
- **Configurable port with a safe default**: Default to 27124 (one above Local REST API to avoid collision) but read from settings so the user can change it if a collision occurs. Save the port choice to settings and surface it in the UI so the Obsidian plugin knows what to hit.
- **SO_REUSEADDR**: Node's `http` server defaults to SO_REUSEADDR off on macOS. Set `server.on('listening', ...)` and handle the EADDRINUSE case by retrying once with a 500 ms delay, and if that fails, incrementing the port by 1 up to 10 times, then giving up with a user-visible error.
- **Graceful shutdown**:
  ```js
  app.on('before-quit', async (event) => {
    if (serverClosed) return;
    event.preventDefault();
    try {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Force-close after 5s even if sockets hang
        setTimeout(() => {
          server.closeAllConnections?.();  // Node 18.2+
          resolve();
        }, 5000);
      });
      serverClosed = true;
    } finally {
      app.quit();  // re-trigger quit with flag set
    }
  });
  ```
  Note: calling `app.quit()` from inside `will-quit` after `preventDefault()` requires wrapping in `setTimeout(() => app.quit(), 0)` on some platforms (per electron/electron#33643) — `before-quit` is safer.
- **CORS**: The Obsidian plugin uses `requestUrl()` which bypasses CORS entirely — it's a Node-level HTTP request, not a fetch. You DON'T need CORS headers on the loopback server. But if the plugin ever falls back to `fetch()`, or if you want to test the endpoints from a browser, add `Access-Control-Allow-Origin: app://obsidian.md` explicitly (NOT `*` — that's over-permissive even on loopback).
- **Health check endpoint**: `GET /health → { version, pid, uptime }` so the plugin can detect "app not running" vs. "app running but endpoint broken" vs. "wrong version".
- **No authentication required** given loopback-only + single-user (per PROJECT.md), but add a random shared secret generated on first launch anyway — it's a 20-line defense against a hypothetical malicious local process. Store secret in Keychain, bake into plugin settings during manual plugin install.

**Warning signs:**
- `lsof -i :27124` after app quit still shows the socket in `TIME_WAIT` or `LISTEN`.
- Next app launch log contains `Error: listen EADDRINUSE`.
- Obsidian plugin button shows "request failed" status and app log has no corresponding request entry.
- Note mutations are partially applied (half-replaced speaker names) after an app crash mid-request.

**Phase to address:**
Phase that adds the HTTP bridge (paired with the Obsidian plugin phase). Must be fixed before the plugin phase can validate end-to-end, because port issues masquerade as "the plugin isn't working".

---

### Pitfall 7: Keychain prompts pop up every launch because `safeStorage.isEncryptionAvailable()` is called before `app.ready`

**What goes wrong:**
You (correctly) decide to drop `keytar` (deprecated and archived per the search results) and use `safeStorage` for API keys. You write a nice abstraction:

```js
// secrets.ts
import { safeStorage } from 'electron';

export function getKey(name) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('...');
  // read from app.getPath('userData') + decrypt
}
```

Then you import it in `main.ts` at the top, and the first thing `main.ts` does is read API keys for the pipeline constructor. This produces TWO bugs:

1. Before `app.whenReady()`, `app.name` is not yet set, so the Keychain entry gets created as `"Chromium Safe Storage"` instead of `"PlaudNoteTaker Safe Storage"` (per electron/electron#45328). Every subsequent launch of the signed app is looking for the wrong Keychain entry and either prompts the user to allow "PlaudNoteTaker wants access to Chromium Safe Storage" (confusing, scary) OR silently fails decryption.
2. On macOS, this prompt is "always allow" capable — but because the requesting app identifier changes between dev runs (`Electron` helper vs. signed `PlaudNoteTaker.app`), the user gets the prompt at least twice (once in dev, once after signing) and possibly every time they rebuild from source in dev.

Also: the re-notarization cycle changes the signed binary hash; Keychain scopes "always allow" to the signing identity. If you re-sign with a different certificate or with an ad-hoc dev signature, stored credentials become inaccessible and your app behaves like a fresh install — from the user's perspective, "why are my API keys gone?"

**Why it happens:**
- `safeStorage` API docs don't loudly warn about the pre-ready state bug. Devs assume it's a pure utility.
- `app.name` defaults to `"Electron"` until `app.setName()` or `app.whenReady()` runs with the built-in name from `package.json`.
- Dev build and signed build have DIFFERENT Keychain access control IDs.

**How to avoid:**
- Call `app.setName('PlaudNoteTaker')` at the very top of `main.ts` BEFORE any import that might touch `safeStorage`. This forces the Keychain entry name deterministically.
- Gate all secret access behind `app.whenReady()`:
  ```js
  // main.ts
  app.setName('PlaudNoteTaker');
  // ...
  app.whenReady().then(async () => {
    const { getKey, setKey } = await import('./secrets');  // dynamic import
    const apiKeys = await loadKeys();
    startPipeline(apiKeys);
  });
  ```
- Store not just API keys but also the Obsidian plugin's shared secret (see Pitfall 6) in Keychain.
- Use one fixed Keychain "service name" (e.g., `com.marcpanu.PlaudNoteTaker`) regardless of whether the app is signed or dev — so dev builds can re-use the user's real credentials and you can test without re-entering keys. BUT: warn the user that credentials ARE shared between dev and production — fine for a single-user setup, dangerous otherwise.
- Document the "always allow" prompt UX in onboarding: first launch after signing WILL prompt; tell the user to click "Always Allow" to avoid future prompts.
- Never log the decrypted values. Ever. Log "read secret X succeeded" / "read secret X failed", never the value.
- For the migration step (Pitfall 5), read `.env` → import each key via `safeStorage.encryptString()` → store encrypted blob in `~/Library/Application Support/PlaudNoteTaker/keys.enc`. Delete the encrypted blob only after the user confirms "keys imported" in the UI — don't force the user into a dead state if migration crashed.

**Warning signs:**
- Keychain Access.app shows an entry named `"Chromium Safe Storage"` owned by PlaudNoteTaker.
- User clicks "Always Allow" on the Keychain prompt, but the prompt reappears on next launch.
- After a code-signing certificate rotation (or switching between dev and production builds), API keys are "gone" (actually: inaccessible under new signing identity).
- `safeStorage.isEncryptionAvailable()` returns `true` but decryption throws. (This happens if the encryption key is correctly accessible but the ciphertext was encrypted under a different key.)

**Phase to address:**
Same phase as first-run migration (Pitfall 5). Keychain import is a subroutine of the broader "move secrets and state into the app" work.

---

### Pitfall 8: Obsidian plugin's injected button leaks DOM nodes or double-fires on vault re-render

**What goes wrong:**
The plugin uses `registerMarkdownPostProcessor` to find the "Unknown Speakers" callout and inject a "Match speakers" button. All good in the happy path. Then:

1. User edits the note (even a whitespace change) — Obsidian re-renders the preview, the post-processor fires again, a SECOND button appears. Now there are two buttons, both with the same click handler. User clicks the first one; the match flow runs; the note is updated; the server responds with 200. But the second button is now wired to a handler closing over stale note content (before the update), and clicking it POSTs stale data to the server, corrupting the match.
2. User switches vaults with the plugin enabled. The plugin's event listeners and injected buttons were attached to the first vault's DOM; vault switch tears down those DOM nodes, but the attached event handlers don't get garbage collected because they close over plugin state — memory leak grows every vault switch.
3. Developer uses the `hot-reload` plugin during development. Changing plugin code reloads the plugin, but `unload()` doesn't properly detach the MarkdownRenderChild lifecycle — ghost buttons accumulate.

**Why it happens:**
- Obsidian's post-processor contract expects you to attach lifecycle management via `context.addChild(new MarkdownRenderChild(el))`. Skipping this means Obsidian can't call your cleanup when the rendered block is invalidated.
- `registerMarkdownPostProcessor` callback fires on every re-render, not just new renders.
- Plugin `onunload()` must explicitly reverse everything `onload()` did; the framework doesn't auto-cleanup DOM injections.

**How to avoid:**
- Wrap button injection in a MarkdownRenderChild:
  ```ts
  this.registerMarkdownPostProcessor((element, context) => {
    const callouts = element.querySelectorAll('.callout[data-callout="unknown-speakers"]');
    callouts.forEach((callout) => {
      if (callout.querySelector('.plaud-match-btn')) return;  // idempotence guard
      const child = new MatchSpeakersButton(callout as HTMLElement, context.sourcePath);
      context.addChild(child);  // Obsidian manages lifecycle now
    });
  });

  class MatchSpeakersButton extends MarkdownRenderChild {
    constructor(private el: HTMLElement, private sourcePath: string) { super(el); }
    onload() {
      const btn = this.el.createEl('button', { text: 'Match speakers', cls: 'plaud-match-btn' });
      this.registerDomEvent(btn, 'click', this.handleClick.bind(this));  // auto-cleanup
    }
    async handleClick() {
      // always re-read sourcePath fresh; don't cache content
      const res = await requestUrl({
        url: `http://127.0.0.1:${port}/match-speakers`,
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({ notePath: this.sourcePath }),
      });
      // ...
    }
  }
  ```
- Use `registerDomEvent` / `registerEvent` / `registerInterval` instead of raw `addEventListener` / `setInterval` — Obsidian auto-cleans these on plugin unload.
- Use the idempotence guard (`if (callout.querySelector('.plaud-match-btn')) return;`) to survive double-fires on re-render.
- Use `requestUrl()` from the `obsidian` module, NOT `fetch()` — `fetch()` from the `app://obsidian.md` origin will trigger CORS against your loopback server, and you'd have to ship CORS preflight handling. `requestUrl()` bypasses CORS entirely (confirmed in the Obsidian plugin docs).
- In `onunload()`, explicitly remove any injected DOM nodes and detach listeners that weren't registered via the lifecycle helpers. Use the browser dev tools (Ctrl-Shift-I in Obsidian) to verify no ghost listeners remain after unload.
- Test the hot-reload workflow during development: edit plugin → save → verify no duplicate buttons appear in an existing note.

**Warning signs:**
- Two "Match speakers" buttons on the same callout after editing the note.
- Chrome DevTools → Memory → Heap Snapshot shows growing `HTMLButtonElement` count after repeated vault switches.
- Server receives 2 POST requests for 1 button click.
- Plugin logs an error or warning about "element already has child" or similar.

**Phase to address:**
Obsidian plugin phase (dedicated). Verify during the plugin's functional tests by: rendering a note with the callout, editing the note, confirming the button count stays at 1.

---

### Pitfall 9: Launch-at-login uses deprecated API or fails silently after update

**What goes wrong:**
You set `app.setLoginItemSettings({ openAtLogin: true })` because that's what the Electron docs showed historically. On macOS 13+ this internally uses SMAppService (correct), but:

1. On macOS 13.6 specifically, there's a [known launchd bug](https://theevilbit.github.io/posts/smappservice/) where the launchd job doesn't get disabled when the user toggles the setting off — so "disable launch at login" appears to work in your UI but the app still launches at login.
2. If the user signs in to an admin account and revokes the login item via System Settings → General → Login Items, your `app.getLoginItemSettings()` call may return stale state, and the UI toggle disagrees with system reality.
3. First-time registration of a login item on macOS 13+ requires user approval in System Settings. Your app calls `setLoginItemSettings({ openAtLogin: true })`, it returns no error, but the user sees "PlaudNoteTaker added to Login Items — requires approval" in System Settings and never approves it. From the app's perspective, launch-at-login is enabled; from the user's perspective, it doesn't work.
4. Worse: `app.setLoginItemSettings` can silently fail if the app is not in `/Applications/`. Running the app from `~/Downloads/` or from a DMG mount makes the call succeed but the login item registration is rejected by the system.

**Why it happens:**
- SMAppService requires a real, installed, signed app bundle. Dev builds or DMG-mounted builds don't qualify.
- Apple deliberately moved approval out of the app's hands into System Settings for macOS 13+.
- The API surface (`setLoginItemSettings`) hasn't changed semantically but the OS underneath has.

**How to avoid:**
- In the Settings UI, always call `app.getLoginItemSettings()` to read the CURRENT state before rendering the toggle, don't cache the "user last clicked X".
- If `setLoginItemSettings({ openAtLogin: true })` returns without error but the next `getLoginItemSettings()` reports `openAtLogin: false`, surface a dialog: "Open System Settings → General → Login Items to approve PlaudNoteTaker."
  ```js
  const { shell } = require('electron');
  shell.openPath('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  ```
- Before calling `setLoginItemSettings`, validate that `app.getPath('exe')` is under `/Applications/`. If not, warn the user: "Launch at login requires the app to be in /Applications. Drag PlaudNoteTaker to Applications first."
- Explicitly document "launch at login isn't magical" in onboarding — users may need to approve in System Settings once.
- Test with a clean `tccutil reset SystemPolicyAllFiles` (or a fresh user account) to verify the first-run approval UX.
- Don't use `app.setLoginItemSettings({ openAsHidden: true })` expecting it to work on macOS 13+ — `openAsHidden` was removed in favor of SMAppService behavior. Set `LSUIElement` in Info.plist instead (the Dock-hiding mechanism), and the app launches hidden automatically.

**Warning signs:**
- User toggles "Launch at login" on, logs out, logs in, app doesn't start.
- Settings toggle state disagrees with System Settings → Login Items.
- Console.app shows `com.apple.ServiceManagement` errors during registration.
- App launches at login in dev but not after install (because dev is not in /Applications).

**Phase to address:**
Phase that adds Settings UI / launch-at-login toggle. Paired with LSUIElement / menubar setup.

---

### Pitfall 10: `LSUIElement` misconfigured — app either shows in Dock or loses menubar icon

**What goes wrong:**
You want a pure menubar app (hidden from Dock) per PROJECT.md. Two failure modes:

1. You don't set `LSUIElement` in Info.plist and only call `app.dock.hide()` in main process. Result: Dock icon flickers visibly on launch for ~500 ms, then disappears. Ugly but functional (per electron/electron#3498). Bad first impression.
2. You set `LSUIElement = true` in Info.plist via `electron-builder`'s `mac.extendInfo` config. This succeeds, but some misconfigurations (e.g., missing `LSBackgroundOnly` interplay) can cause the app to launch WITHOUT a menubar icon on some macOS builds — the app is running (visible in Activity Monitor) but invisible to the user. No Dock icon, no menu bar icon, no way to quit except Activity Monitor → Force Quit.

**Why it happens:**
- `LSUIElement` and `LSBackgroundOnly` are similar-sounding but different; `LSBackgroundOnly` hides the menubar entirely.
- `app.dock.hide()` is a runtime call; by the time it runs, the Dock has already decided to render the icon.

**How to avoid:**
- Prefer Info.plist `LSUIElement = true` (no Dock icon from the start, no flicker).
- Configure in `electron-builder.yml`:
  ```yaml
  mac:
    extendInfo:
      LSUIElement: true
      # DO NOT add LSBackgroundOnly
  ```
- Do NOT also call `app.dock.hide()` — it's redundant with LSUIElement and has caused interaction bugs in the past.
- Test: build the app, drag to `/Applications`, launch, verify (a) no Dock icon ever appears, (b) menubar icon appears within 2 seconds, (c) clicking it opens the popover.
- If something goes wrong during dev and the menubar icon doesn't appear: force-quit via `killall PlaudNoteTaker` in Terminal. Don't lose your muscle memory for this — during development you WILL hit this at least once.

**Warning signs:**
- Dock shows icon for 500 ms then disappears.
- Menubar icon never appears but `ps aux | grep Plaud` shows process running.
- App appears in `Cmd-Tab` switcher (it shouldn't for a menubar app).

**Phase to address:**
Electron scaffold / menubar phase. Info.plist config is one of the first things set.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Keep synchronous file I/O in `state.ts` (per CONCERNS.md) when moving poll loop to Electron main process | No refactor cost; pipeline code untouched | Every poll blocks Electron's event loop (which also serves IPC to the renderer); popover becomes unresponsive during JSON writes. Compounds Pitfall 4 (poll loop reliability). | MVP, if history files stay small. Convert to `fs.promises` before history exceeds 100 entries. |
| Use `app.dock.hide()` instead of `LSUIElement` | One-line change; no Info.plist fiddling | Dock flicker on launch (Pitfall 10); worse first impression; marginally complicates future debugging | Never — LSUIElement is the right answer and costs no more to configure. |
| Copy `.env` values directly into `safeStorage` without validating them (just trust they work) | Faster onboarding flow | Invalid keys (typos, expired) cause errors deep in the pipeline — user sees "AssemblyAI 401" instead of "your migrated key is bad, re-enter it". | Never — the migration flow is the ONE place where validating keys is cheap (one test call each) before committing them. |
| Hardcode ffmpeg path to `Contents/Resources/bin/ffmpeg` in `audio.ts` instead of via env var | No config plumbing | CLI (which reads from `$PATH`) and app (which reads hardcoded path) diverge; CONCERNS.md #1 warns this will break one or the other | Acceptable with a clear abstraction: a `getFfmpegPath()` function that checks packaged-resource-path first, then `$PATH`, fails with a clear error. |
| Skip `@electron/rebuild` and rely on whatever prebuild npm installed | Faster `npm install` | Crashes at runtime, possibly on end-user's machine only. See Pitfall 1. | Never. |
| Bind HTTP server to `localhost` string instead of `127.0.0.1` IP | Reads more naturally | On some IPv6-first macOS configs, binds only to `::1`, so the plugin (which may default to `127.0.0.1`) cannot connect | Never — always use `127.0.0.1` explicitly. |
| Use `keytar` (familiar API) instead of `safeStorage` | Familiar code; still works | `keytar` is archived (Mar 2026 per search results) and will bitrot against future Electron versions. | Never for a new project. Existing projects should migrate. |
| Reuse the same JSON file format for state with no version field | Nothing to design | Future state-format changes (e.g., adding a field to `recording-meta.json`) trigger silent data loss or corruption on downgrade. | MVP if you accept that state migrations won't exist. Add a `schemaVersion` field in the migration work anyway — it's one field. |
| No shared secret on the HTTP bridge ("loopback is safe") | Less code | A malicious local process (unlikely but possible) could POST to the endpoint and trigger note modifications without user consent. | Acceptable for single-user personal tool; ship the secret infrastructure anyway because it's ~20 lines and eliminates the category of concern. |

## Integration Gotchas

Common mistakes when connecting to external services.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `@picovoice/eagle-node` | Not rebuilding against Electron ABI; assuming the npm prebuild works | `@electron/rebuild` as a `postinstall`, verified in CI smoke test (Pitfall 1) |
| `@picovoice/eagle-node` | Passing a `Uint8Array` instead of `ArrayBuffer` when deserializing profiles (per commit `8d0a17b`) | Use `.buffer` accessor or `new Uint8Array(buf).buffer`; verify the fix from that commit isn't lost during refactor |
| ffmpeg bundled binary | Using the x64 `ffmpeg-static` binary on Apple Silicon; relying on Rosetta | Use a universal or arm64-native ffmpeg; verify with `lipo -archs` (Pitfall 2) |
| ffmpeg bundled binary | Assuming `codesign --deep` signs it recursively | Explicit `codesign` call for each bundled binary in `afterSign` hook (Pitfall 2) |
| ffmpeg bundled binary | Hardcoding `/usr/local/bin/ffmpeg` from CLI habit | Resolve path via `app.isPackaged ? path.join(process.resourcesPath, 'bin/ffmpeg') : 'ffmpeg'` |
| macOS Keychain | Calling `safeStorage` before `app.whenReady()` | Gate all secret access behind `app.whenReady()`, `app.setName()` before any secret import (Pitfall 7) |
| Obsidian plugin | Using `fetch()` to call the loopback server (CORS blocked) | Use `requestUrl()` from the `obsidian` module (Pitfall 8) |
| AssemblyAI | Relying on error-text pattern matching for retry decisions (per CONCERNS.md) | Retry on HTTP 5xx + network errors (`ECONNRESET`, `ETIMEDOUT`) — this matters more in the Electron context because sleep/wake surfaces more network errors (Pitfall 4) |
| Plaud API | Assuming `fetch` socket survives macOS sleep/wake cleanly | Tie every `fetch` to an `AbortSignal`; cancel and re-issue on `powerMonitor` `resume` event (Pitfall 4) |
| Gemini API | Assuming the "FOLDER:" line in summary output is present (per CONCERNS.md bug #5) | Log explicitly when folder parsing fails; surface in app UI log stream (PROJECT.md requires this) so template changes are debuggable |
| Obsidian vault writes | Writing notes while the plugin's match-speakers flow is mid-edit | Use `app.vault.process()` with atomic read-modify-write semantics; NEVER hand-read + hand-write the same file concurrently from two places |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| `readFileSync`/`writeFileSync` on state files in poll loop (CONCERNS.md) | Popover sluggishness; dropped IPC events | Convert to `fs.promises` + in-memory cache with periodic flush | Visible at ~100 history entries; painful at ~500 |
| Holding a full audio file (~500 MB) in memory during processing | macOS swap pressure; other apps slow down | Stream from Plaud → temp file → ffmpeg → discard | At any recording ≥ 100 MB on a 16 GB Mac with Chrome, Slack, etc. running |
| Synchronous `execSync('find ...')` vault scan (CONCERNS.md) | Poll cycle pauses 1–5 s on large vaults | Replace with `fs.promises.readdir({ recursive: true })` (Node 18+) | At ~1000 vault folders |
| Fixed 3-second AssemblyAI poll interval (CONCERNS.md) | Short audio (< 1 min) has 3-second tail latency | Exponential backoff 1 s → 5 s | Always — small but visible on every recording |
| Creating a new `Eagle` instance per poll cycle (in-memory model load) | CPU spike + memory churn every poll | Initialize once in main process; pass the instance down | Audible fan noise at ≥ 1 recording every few polls |
| Serializing all IPC through `ipcMain.handle()` for log-stream updates | Renderer can't keep up; buffer grows | Use `WebContents.send()` with a rate limiter (max N events/sec) or a `ReadableStream` | When log volume exceeds ~10 events/sec during heavy processing |

## Security Mistakes

Domain-specific security issues beyond general web security.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging decrypted API keys to the in-app log stream | Keys visible in user's log UI; might get pasted into bug reports | Redact any known-secret value before logging; use a redact-at-source allowlist |
| Not validating `notePath` in the Obsidian bridge `/match-speakers` endpoint | A malicious local process could POST `{ notePath: "../../../etc/passwd" }` and trick the app into reading files outside the vault | Resolve the incoming path against the configured vault root; reject if outside |
| Loopback server accepts requests with `Host: <hostname>.local` (LAN-facing) because Node's `127.0.0.1` bind accepts any Host header | Reduced attack surface if someone finds a way to connect | Validate the `Host` header: only accept `127.0.0.1`, `localhost`, or your configured bind address |
| Keychain shared-secret stored in plugin settings as plaintext | If user's Obsidian vault is synced (iCloud, Dropbox), secret leaks to cloud | Don't store in vault — generate fresh on each app launch, require plugin to call `/hello` to retrieve per-session; OR store in Obsidian's isolated plugin-data dir (not synced unless user explicitly syncs it) |
| Full transcripts in vault notes with speaker names (CONCERNS.md) | Sensitive conversations exposed if vault syncs to cloud | Document the behavior; offer optional `INCLUDE_TRANSCRIPT=false` flag |
| `disable-library-validation` entitlement granted (necessary — see Pitfall 3) | Any `.dylib` loadable into the process; broader attack surface if an attacker has local code-exec already | Accept the risk (necessary for native modules); don't add additional relaxations like `allow-dyld-environment-variables` unless required |
| Not re-validating ffmpeg is present at every poll (CONCERNS.md) | If ffmpeg is removed from `Contents/Resources/` (partial app update, disk corruption), pipeline fails silently | Add a `verifyFfmpeg()` check to the poll loop that spawns `ffmpeg -version` once per app startup; fail loudly if missing |

## UX Pitfalls

Common user experience mistakes in this domain.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Menubar icon with no distinction between "running", "polling", "error" states | User doesn't know if the app is working | Three icon states: idle (gray), active (color/animated during poll), error (red dot) |
| Popover only shows "recent notes" — no indication the app is actively working | User assumes nothing is happening | Add a "Processing: <recording name>" line when the pipeline is mid-poll |
| First-run onboarding that requires entering 4 API keys before anything works | Abandonment | Import from existing `.env` during migration (PROJECT.md already mandates this) + test each key with a ping call before committing |
| Silent failures (the #1 UX pitfall in the existing CLI per CONCERNS.md) | User finds out days later notes were missed | Surface every error as a macOS notification + an entry in the Logs tab; distinguish "retryable" from "fatal" via icon |
| "Match speakers" button gives no feedback after click (before the match completes) | User clicks again, double-triggers | Disable button + show spinner + show "Matching..." text; restore only on response |
| App quits silently when the menubar icon's "Quit" is clicked mid-poll | User may not realize their recording was mid-processing | Confirm dialog if there's an active poll: "PlaudNoteTaker is processing a recording. Quit anyway?" |
| Settings changes require app restart | Users tolerate this in enterprise apps, dislike it in personal tools | Settings that change the poll interval, Gemini model, or templates folder should apply on next poll, not restart |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Electron scaffold:** Often missing `@electron/rebuild` in `postinstall` — verify `eagle-node` loads in packaged app, not just dev.
- [ ] **ffmpeg bundling:** Often missing individual `codesign` call in `afterSign` — verify with `codesign --verify --deep --strict <app>` and a test notarization run.
- [ ] **Notarization:** Often missing `entitlementsInherit` — verify both `mac.entitlements` AND `mac.entitlementsInherit` in `electron-builder.yml`; test on a second clean Mac.
- [ ] **Launch at login:** Often missing "user must approve in System Settings" flow on macOS 13+ — verify by toggling on, logging out/in, confirming app actually starts.
- [ ] **Menubar-only app:** Often missing `LSUIElement: true` in Info.plist — verify no Dock flicker, no Cmd-Tab entry.
- [ ] **Poll loop:** Often missing `powerMonitor` resume handler — verify by suspending the Mac, waking, checking that a poll fires within seconds.
- [ ] **HTTP bridge:** Often missing graceful shutdown with timeout — verify by Cmd-Q during an in-flight match-speakers request; app must quit, port must be released, Obsidian plugin must get a sensible error.
- [ ] **HTTP bridge:** Often missing `127.0.0.1` explicit bind — verify `curl http://<LAN-IP>:<port>/health` refuses connection from a second machine.
- [ ] **Keychain integration:** Often missing `app.setName()` before first `safeStorage` use — verify Keychain Access.app shows correct entry name.
- [ ] **Obsidian plugin:** Often missing MarkdownRenderChild wrapper — verify only one button per callout after editing the note.
- [ ] **Obsidian plugin:** Often using `fetch()` instead of `requestUrl()` — verify no CORS errors in Obsidian DevTools console.
- [ ] **First-run migration:** Often missing atomic rollback — verify by killing the app process mid-migration, relaunching, confirming clean state (either pre-migration or fully-migrated, never partial).
- [ ] **First-run migration:** Often missing Eagle profile byte-preservation — after migration, run a speaker match and confirm results match what the CLI produced pre-migration.
- [ ] **First-run migration:** Often missing sentinel file — verify migration doesn't run a second time on next launch.
- [ ] **Logging:** Often includes decrypted secrets in "failed to authenticate with key X" messages — verify redaction of any known-key-pattern value.
- [ ] **CLI compatibility:** Often breaks because `./data/` path is now `~/Library/Application Support/...` — verify CLI still writes to `./data/` (original behavior) and app writes to the Application Support dir (no convergence).

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Eagle ABI mismatch surfaces in packaged app | LOW | Re-run `electron-rebuild`, re-package, re-notarize. ~30 min including Apple notarization turnaround. |
| ffmpeg binary fails notarization | LOW | Add the `afterSign` codesign call, resubmit. First time: 30–60 min; subsequent times: 10 min. |
| Hardened runtime entitlements missing | LOW | Fix the plist, resubmit. One-time fix. |
| Poll loop stuck after sleep/wake | MEDIUM | Click "Poll Now" in the popover. Longer-term fix: add `powerMonitor` handler and ship an update. |
| First-run migration corrupts state | HIGH | If repo-dir `./data/` was untouched (per PROJECT.md), restore by deleting `~/Library/Application Support/PlaudNoteTaker/` and re-launching. If repo-dir was also corrupted: no recovery except re-processing from Plaud (lose speaker profiles). THIS IS WHY the migration must be atomic + preserve the source. |
| HTTP server port in use | LOW | Configurable port (settings toggle) bumps to next available; notify user in Logs tab. |
| Keychain prompt keeps firing | MEDIUM | User must manually delete the "Chromium Safe Storage" entry in Keychain Access.app and re-enter keys; fix `app.setName()` in code and re-ship. |
| Obsidian plugin button duplicates | LOW | User disables/re-enables the plugin; fixed by the MarkdownRenderChild wrapper in the next release. |
| Launch-at-login silently off | LOW | User manually toggles in System Settings → General → Login Items. App surfaces a "approve in System Settings" hint on next launch. |
| Notarization rejected with no clear reason | HIGH | `xcrun notarytool log <submission-id> --keychain-profile <profile>` gives detailed per-file errors; iterate. Budget 2–3 cycles. |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Eagle native module ABI mismatch | Electron scaffold (first phase that adds Electron) | Smoke test: `electron-rebuild` runs in `postinstall`, packaged app's first `require('@picovoice/eagle-node')` works |
| 2. ffmpeg notarization failure | Packaging / signing phase | `notarytool log` returns no errors for `Contents/Resources/bin/ffmpeg`; `codesign --verify --deep --strict` passes |
| 3. Hardened runtime entitlements | Packaging / signing phase (same phase as Pitfall 2) | App launches successfully on a SECOND clean Mac (not just the dev machine); no CODESIGNING crash reports |
| 4. Poll loop sleep/wake reliability | Phase that moves poll from CLI to Electron main process | Close laptop for > 10 min, open, verify next poll fires within 60 s |
| 5. First-run state migration | Phase that introduces Application Support dir / onboarding | Chaos test: kill app mid-migration, verify clean rollback or clean retry on next launch |
| 6. HTTP bridge port / shutdown | Phase that adds the loopback HTTP server | Cmd-Q during in-flight request: port released within 5 s of quit; `lsof -i :<port>` is empty |
| 7. Keychain prompt UX | Phase that adds Keychain / safeStorage (same phase as Pitfall 5) | Keychain Access.app shows correct app name; second launch doesn't prompt |
| 8. Obsidian plugin DOM leaks | Obsidian plugin phase | Edit note 5 times, verify exactly 1 button per callout; toggle plugin off/on, no ghost listeners |
| 9. Launch-at-login reliability | Phase that adds Settings UI | Toggle on, logout/login, verify app runs; toggle off, logout/login, verify app doesn't run |
| 10. LSUIElement / Dock-hide | Electron scaffold (same phase as Pitfall 1) | No Dock icon flicker on launch; no Cmd-Tab entry |

## Sources

- [Electron — Native Node Modules tutorial](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules) — HIGH confidence
- [electron/rebuild README + issues #1073, #263, #845](https://github.com/electron/rebuild) — HIGH confidence (Node 22.12+ requirement, ABI detection)
- [Electron — ES Modules tutorial](https://www.electronjs.org/docs/latest/tutorial/esm) — HIGH confidence (ESM support requires Electron 28+)
- [Electron — safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage) + [electron/electron#45328](https://github.com/electron/electron/issues/45328) + [electron/electron#43233](https://github.com/electron/electron/issues/43233) — HIGH confidence (pre-ready Keychain name bug is real and documented)
- [Electron — powerMonitor docs](https://www.electronjs.org/docs/latest/api/power-monitor) + [electron/electron#24803](https://github.com/electron/electron/issues/24803) (resume fires twice on macOS) + [electron/electron#4465](https://github.com/electron/electron/issues/4465) (setInterval freezes in background) — HIGH confidence
- [Electron — powerSaveBlocker docs](https://www.electronjs.org/docs/latest/api/power-save-blocker/) — HIGH confidence
- [electron-builder — macOS code signing](https://www.electron.build/code-signing-mac.html) + [Configuration reference](https://www.electron.build/configuration.html) — HIGH confidence
- [Apple — Notarizing macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) + [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues) — HIGH confidence (official)
- [Apple — Allow Unsigned Executable Memory entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-unsigned-executable-memory) — HIGH confidence (official)
- [Kilian Valkhof — Notarizing your Electron application](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/) — MEDIUM confidence (dated 2019 but still accurate for core entitlement patterns)
- [Simon Willison — Signing and notarizing via GitHub Actions TIL](https://til.simonwillison.net/electron/sign-notarize-electron-macos) — MEDIUM confidence
- [BigBinary blog — code-sign + notarize Electron](https://www.bigbinary.com/blog/code-sign-notorize-mac-desktop-app) — MEDIUM confidence
- [lmstudio-ai/lmstudio-bug-tracker#1494](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1494) — MEDIUM confidence (plugin-helper library-validation entitlement pattern)
- [atom/node-keytar#135](https://github.com/atom/node-keytar/issues/135) — MEDIUM confidence ("always allow" UX, though keytar is now deprecated)
- [Freek Van der Herten — Replacing Keytar with safeStorage in Ray](https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray) + [microsoft/vscode#185677](https://github.com/microsoft/vscode/issues/185677) — HIGH confidence (VS Code's migration away from keytar, same migration pattern applies here)
- [theevilbit — SMAppService Quick Notes](https://theevilbit.github.io/posts/smappservice/) — MEDIUM confidence (technical details on SMAppService; 13.6 launchd bug)
- [Apple Developer Forums — LoginItem failing on Ventura RC](https://developer.apple.com/forums/thread/718291) — MEDIUM confidence
- [Obsidian — Markdown post processing API](https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing) + [registerMarkdownPostProcessor reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerMarkdownPostProcessor) — HIGH confidence (official)
- [Obsidian forum — Make HTTP requests from plugins](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461) — HIGH confidence (`requestUrl()` bypasses CORS)
- [Obsidian forum — registerMarkdownPostProcessor Live Preview caveat](https://forum.obsidian.md/t/registermarkdownpostprocessor-callback-not-called-with-live-preview-mode/56049) — MEDIUM confidence
- [pjeby/hot-reload](https://github.com/pjeby/hot-reload) — MEDIUM confidence (development hot-reload gotchas)
- [electron-userland/electron-builder#8640](https://github.com/electron-userland/electron-builder/issues/8640) (asarUnpack quirks), [#1102](https://github.com/electron-userland/electron-builder/issues/1102), [#1120](https://github.com/electron-userland/electron-builder/issues/1120) (can't spawn from asar) — HIGH confidence
- [Electron issues #422](https://github.com/electron/electron/issues/422), [#3498](https://github.com/electron/electron/issues/3498), [#1456](https://github.com/electron-userland/electron-builder/issues/1456) — MEDIUM confidence (LSUIElement + dock.hide behavior)
- [Electron app.setLoginItemSettings docs](https://www.electronjs.org/docs/latest/api/app) — HIGH confidence
- [electron/electron#33643](https://github.com/electron/electron/issues/33643) (will-quit + preventDefault + app.quit interaction) — MEDIUM confidence
- [.planning/codebase/CONCERNS.md (this repo, 2026-04-16)](../codebase/CONCERNS.md) — HIGH confidence (local analysis, directly relevant to existing tech debt that must not be amplified)
- [.planning/PROJECT.md (this repo, 2026-04-16)](../PROJECT.md) — HIGH confidence (project requirements + locked decisions)
- Commit `8d0a17b` "Fix Eagle speaker profile serialization — use ArrayBuffer not Uint8Array" — HIGH confidence (specific prior-art gotcha in this codebase; must not be lost in migration work)

---
*Pitfalls research for: Signed + notarized macOS Electron menubar app with native modules, bundled ffmpeg, loopback HTTP bridge, and Obsidian plugin pairing*
*Researched: 2026-04-16*
