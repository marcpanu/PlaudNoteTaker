// Phase 3: Electron main process — full daemon wiring.
// Phase 4 adds: popover window, notifications, HTTP bridge.

// ── CRITICAL: app.setName MUST be the first statement, before ANY safeStorage import ──
// Pitfall 7: if app.name is not set before safeStorage is used, the Keychain entry is
// created as "Chromium Safe Storage" and subsequent launches will re-prompt.
import { app } from "electron";
app.setName("Plaud Obsidian Note Taker");

import { Tray, nativeImage, dialog } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// App subsystems (all imports after app.setName)
import { getPaths, ensureDirs, ffmpegPath, trayIconPath } from "./app/paths.js";
import { acquireLock, releaseLock } from "./app/single-instance.js";
import { attach as attachLogBuffer, detach as detachLogBuffer } from "./app/log-buffer.js";
import { status as migrationStatus } from "./app/migration.js";
import { loadConfigFromApp } from "../src/config/app-loader.js";
import { getSecret } from "./app/secrets.js";
import type { SecretKey } from "./app/secrets.js";
import { start as serviceStart, stop as serviceStop, getVaultPath } from "./app/service.js";
import { attach as iconStateAttach, detach as iconStateDetach } from "./app/icon-state.js";
import { openSettings, openLogs, registerSettingsShortcut } from "./app/windows.js";
import { registerIpcHandlers } from "./app/ipc-handlers.js";
import { togglePopover, showPopover } from "./app/popover-window.js";
import { setupNotifications } from "./app/notifications.js";
import { startBridge, stopBridge } from "./app/bridge.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Single-instance lock (Electron-level: second window focus) ────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[main] another instance already running; exiting");
  app.quit();
} else {
  app.on("second-instance", () => {
    // Phase 4: focus the popover (if tray is ready), else open Settings.
    console.log("[main] second-instance detected — opening popover");
    if (tray && !tray.isDestroyed()) {
      showPopover(tray);
    } else {
      openSettings();
    }
  });
}

// Suppress macOS Dock icon defensively (LSUIElement in Info.plist is authoritative,
// but dock.hide() ensures dev runs (npm run forge:start) also hide the Dock icon).
if (process.platform === "darwin") {
  app.dock?.hide();
}

// Closing windows should not quit the daemon.
app.on("window-all-closed", (e: Electron.Event) => {
  e.preventDefault();
});

let tray: Tray | null = null;

function createTray(): Tray {
  const iconPath = trayIconPath({ state: "idle" });
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);

  const t = new Tray(icon);
  t.setToolTip("Plaud Obsidian Note Taker");

  // Single interaction surface: the popover. No right-click menu — every
  // action the user needs (Poll Now, Start/Stop, Settings, Logs) lives in
  // the popover. About content moved to the Settings > About tab. Quit via
  // Cmd-Q (registered through the application menu by registerSettingsShortcut).
  t.on("click", () => {
    togglePopover(t);
  });
  t.on("right-click", () => {
    togglePopover(t);
  });

  return t;
}

/**
 * Eagle smoke test — preserved from Phase 2a.
 * Goal: prove @picovoice/eagle-node 3.0 loads under Electron's Node ABI.
 */
function loadEagle(): { EagleProfiler: new (accessKey: string) => { version: string; release: () => void } } {
  if (app.isPackaged) {
    const eagleDir = join(process.resourcesPath, "eagle-node");
    return require(eagleDir) as { EagleProfiler: new (key: string) => { version: string; release: () => void } };
  }
  return require("@picovoice/eagle-node") as { EagleProfiler: new (key: string) => { version: string; release: () => void } };
}

function runEagleSmoke(): "ok" | "module loaded" | "abi mismatch" | "hard fail" {
  let EagleProfiler: new (accessKey: string) => { version: string; release: () => void };
  try {
    ({ EagleProfiler } = loadEagle());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[eagle-smoke] require failed:", msg);
    if (msg.includes("NODE_MODULE_VERSION")) {
      console.error("[eagle-smoke] ABI MISMATCH — need Electron 40 fallback");
      return "abi mismatch";
    }
    return "hard fail";
  }

  const accessKey = process.env.PICOVOICE_ACCESS_KEY ?? "";
  if (accessKey) {
    try {
      const profiler = new EagleProfiler(accessKey);
      console.log(`[eagle-smoke] ok — EagleProfiler constructed, version ${profiler.version}`);
      profiler.release();
      return "ok";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("NODE_MODULE_VERSION")) {
        console.error("[eagle-smoke] ABI MISMATCH on construction");
        return "abi mismatch";
      }
      console.error("[eagle-smoke] construction failed (key issue, not ABI):", msg);
      return "module loaded";
    }
  }

  try {
    const p = new EagleProfiler("__invalid__");
    console.log(`[eagle-smoke] unexpectedly constructed with invalid key; version=${p.version}`);
    p.release();
    return "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NODE_MODULE_VERSION")) {
      console.error("[eagle-smoke] ABI MISMATCH — need Electron 40 fallback");
      return "abi mismatch";
    }
    console.log("[eagle-smoke] module loaded (invalid key, but ABI ok):", msg);
    return "module loaded";
  }
}

/**
 * ffmpeg probe — verify bundled binary is resolvable and executable.
 */
function runFfmpegProbe(): { ok: boolean; path: string; version?: string; error?: string } {
  const path = ffmpegPath();
  if (!existsSync(path)) {
    return { ok: false, path, error: `ffmpeg binary not found at ${path}` };
  }
  const result = spawnSync(path, ["-version"], { encoding: "utf-8" });
  if (result.error) {
    return { ok: false, path, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, path, error: `ffmpeg exited ${result.status}: ${result.stderr}` };
  }
  const firstLine = (result.stdout || "").split("\n")[0] ?? "";
  return { ok: true, path, version: firstLine };
}

// ── Main startup sequence ─────────────────────────────────────────────────────

app.whenReady().then(async () => {
  console.log("[main] app ready");

  // 1. Ensure userDataDir and dataDir exist
  ensureDirs();
  const { userDataDir, dataDir } = getPaths();
  console.log(`[main] paths ensured → userDataDir=${userDataDir} dataDir=${dataDir}`);

  // 2. ffmpeg check — hard fail if missing (pipeline cannot work without it)
  const ffmpeg = runFfmpegProbe();
  if (ffmpeg.ok) {
    console.log(`[main] ffmpeg check ok — ${ffmpeg.version} (path: ${ffmpeg.path})`);
  } else {
    console.error(`[main] ffmpeg check FAIL — ${ffmpeg.error}`);
    await dialog.showMessageBox({
      type: "error",
      title: "ffmpeg not found",
      message: "ffmpeg binary is missing or not executable.",
      detail: `Expected at: ${ffmpeg.path}\n\nThe app cannot process recordings without ffmpeg.`,
      buttons: ["Quit"],
    });
    app.exit(1);
    return;
  }

  // 3. Pidfile lock (coordinates with CLI)
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    // acquireLock already showed a dialog and called app.exit(1)
    return;
  }
  console.log("[main] pidfile lock acquired");

  // 4. Eagle smoke test (non-fatal — Eagle is optional)
  const eagleResult = runEagleSmoke();
  console.log(`[main] eagle smoke: ${eagleResult}`);

  // 5. Attach log buffer to pub/sub BEFORE any service logs
  attachLogBuffer();
  console.log("[main] log buffer attached");

  // 6. Check migration status
  const migStatus = migrationStatus(userDataDir);
  console.log(`[main] migration status: ${migStatus.kind}`);

  // 7. Load config
  const secretGetter = (key: string) => getSecret(key as SecretKey);
  const config = await loadConfigFromApp(userDataDir, secretGetter);
  if (config) {
    console.log("[main] config loaded — starting daemon");
    await serviceStart(config);
  } else {
    console.log("[main] config incomplete — daemon paused; opening Settings");
  }

  // 8. Create tray + attach icon-state
  tray = createTray();
  iconStateAttach(tray);
  console.log("[main] tray created");

  // 9. Register IPC handlers
  registerIpcHandlers();
  console.log("[main] IPC handlers registered");

  // 10. Register Cmd-, shortcut
  registerSettingsShortcut();

  // 11. If migration source found or config incomplete, open Settings
  if (migStatus.kind === "source_found" || !config) {
    openSettings();
  }

  // 12. Initialize notifications + subscribe to service events
  setupNotifications(userDataDir);
  console.log("[main] notifications initialized");

  // 13. Start loopback HTTP bridge (127.0.0.1 only, ephemeral port, bridge.json written)
  startBridge({
    userDataDir,
    getVaultPath,
  }).catch((err: unknown) => {
    console.error("[main] bridge failed to start:", err);
  });

  console.log(
    `[smoke-summary] eagle=${eagleResult} ffmpeg=${ffmpeg.ok ? "ok" : "fail"} packaged=${app.isPackaged} ` +
    `migration=${migStatus.kind} config=${config ? "loaded" : "null"}`,
  );
}).catch((err) => {
  console.error("[main] startup failed:", err);
  app.exit(1);
});

app.on("before-quit", async () => {
  console.log("[main] before-quit");
  await stopBridge();
  await serviceStop();
  iconStateDetach();
  detachLogBuffer();
  releaseLock();
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
});
