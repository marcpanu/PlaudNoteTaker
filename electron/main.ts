// Phase 2a: Electron main process — menubar skeleton + Eagle smoke + ffmpeg probe.
// Phase 3 adds: config load (Keychain), migration, service facade, poll loop, IPC.
// Phase 4 adds: popover window, notifications, HTTP bridge.

import { app, Tray, Menu, nativeImage, dialog } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Single-instance lock. Second launch focuses the (eventual) window or no-ops.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[main] another instance already running; exiting");
  app.quit();
} else {
  app.on("second-instance", () => {
    // Phase 4: focus the popover here. For 2a, no-op.
    console.log("[main] second-instance detected");
  });
}

// Suppress macOS Dock icon defensively (LSUIElement in Info.plist is authoritative,
// but dock.hide() ensures dev runs (npm run forge:start) also hide the Dock icon
// before Info.plist is applied via Forge packaging).
if (process.platform === "darwin") {
  app.dock?.hide();
}

// Closing windows should not quit the daemon.
app.on("window-all-closed", (e: Electron.Event) => {
  e.preventDefault();
});

let tray: Tray | null = null;

function resolveTrayIconPath(): string {
  // Packaged: icon sits in Contents/Resources/ via forge.config.js extraResource.
  // Dev (forge:start): main.ts bundles to .vite/build/main.js — icon is in repo at electron/assets/.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "iconTemplate.png")]
    : [
        resolve(process.cwd(), "electron/assets/iconTemplate.png"),
        resolve(__dirname, "../../electron/assets/iconTemplate.png"),
      ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

function createTray(): void {
  const iconPath = resolveTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  // Template images render correctly in light/dark menubars when marked as such.
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip("Plaud Obsidian Note Taker");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: `About ${app.name}`,
      click: () => {
        dialog.showMessageBox({
          type: "info",
          title: "About",
          message: "Plaud Obsidian Note Taker",
          detail: `Version ${app.getVersion()}\nBundle: ${process.execPath}`,
          buttons: ["OK"],
        });
      },
    },
    { type: "separator" },
    { role: "quit", label: "Quit" },
  ]);
  tray.setContextMenu(contextMenu);
}

/**
 * Eagle smoke test — THE Phase 2a gate.
 * Goal: prove @picovoice/eagle-node 3.0 loads under Electron's Node ABI.
 * Outcomes:
 *   ok                    → module loads, constructed successfully (valid key present)
 *   module loaded         → module loads, construction fails on invalid key (ABI is fine)
 *   ABI MISMATCH          → NODE_MODULE_VERSION error → pivot to Electron 40
 *   HARD FAIL             → any other error → investigate
 */
function loadEagle(): { EagleProfiler: new (accessKey: string) => { version: string; release: () => void } } {
  // In packaged app: @picovoice/eagle-node lives at process.resourcesPath/eagle-node
  // (copied via forge.config.js extraResource). Forge renames extra resources to
  // their basename, so node_modules/@picovoice/eagle-node → Resources/eagle-node.
  // In dev: use the normal module resolution (node_modules is available).
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

  // No access key available — still prove the native addon loads.
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
    // Expected path: native addon loaded, rejected invalid key.
    console.log("[eagle-smoke] module loaded (invalid key, but ABI ok):", msg);
    return "module loaded";
  }
}

/**
 * ffmpeg probe — prove the bundled binary is resolvable and executable in both
 * dev and packaged contexts.
 */
function resolveFfmpegPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "ffmpeg");
  }
  // Dev: use ffmpeg-static's exported path.
  return require("ffmpeg-static") as string;
}

function runFfmpegProbe(): { ok: boolean; path: string; version?: string; error?: string } {
  const path = resolveFfmpegPath();
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

app.whenReady().then(() => {
  console.log("[main] app ready");
  createTray();
  console.log("[main] tray created");

  const eagleResult = runEagleSmoke();
  console.log(`[eagle-smoke] result: ${eagleResult}`);

  const ffmpeg = runFfmpegProbe();
  if (ffmpeg.ok) {
    console.log(`[ffmpeg-probe] ok — ${ffmpeg.version} (path: ${ffmpeg.path})`);
  } else {
    console.error(`[ffmpeg-probe] FAIL — ${ffmpeg.error} (path: ${ffmpeg.path})`);
  }

  // Expose signals for headless verification.
  console.log(
    `[smoke-summary] eagle=${eagleResult} ffmpeg=${ffmpeg.ok ? "ok" : "fail"} packaged=${app.isPackaged}`,
  );
});

app.on("before-quit", () => {
  console.log("[main] before-quit");
});
