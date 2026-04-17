/**
 * Settings + Logs window factories.
 *
 * Close-to-menubar semantics: windows hide rather than destroy on close,
 * UNLESS the app is actually quitting (in which case they close normally
 * so app.quit() can complete).
 * Cmd-, opens Settings from the global menu even though there's no menu bar.
 */

import { BrowserWindow, Menu, MenuItem, app } from "electron";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tracks whether we're in the app.quit() flow so close handlers can stop
// blocking the quit. Set true on `before-quit`, read by window `close` handlers.
let isQuitting = false;
app.on("before-quit", () => {
  isQuitting = true;
});

// ── Dev server URL detection ──────────────────────────────────────────────────

function getDevServerUrl(name: "settings" | "logs"): string {
  // Vite dev server ports: settings=5173 (default), logs=5174
  // Agent B will set these up; we use Forge's VITE_DEV_SERVER_URL env convention
  const base = process.env[`VITE_DEV_SERVER_URL`];
  if (base) {
    return `${base}${name}/index.html`;
  }
  // Fallback: try the common Vite port
  return `http://localhost:5173/${name}/index.html`;
}

function getProductionUrl(name: "settings" | "logs"): string {
  // In packaged app, renderer HTML is loaded from file://
  // Forge Vite plugin writes renderer output to .vite/renderer/{name}/
  const rendererPath = join(process.resourcesPath, "app.asar", ".vite", "renderer", name, "index.html");
  return `file://${rendererPath}`;
}

function getWindowUrl(name: "settings" | "logs"): string {
  if (app.isPackaged) {
    return getProductionUrl(name);
  }
  return getDevServerUrl(name);
}

// ── Settings Window ───────────────────────────────────────────────────────────

let settingsWindow: BrowserWindow | null = null;

export function openSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 720,
    height: 520,
    title: "Plaud Obsidian Note Taker — Settings",
    show: false, // show after ready-to-show to avoid flash
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for preload to access Electron APIs
    },
  });

  settingsWindow.on("ready-to-show", () => {
    settingsWindow?.show();
    // In dev mode, open DevTools automatically so preload/IPC problems are
    // visible without digging through Cmd+Opt+I.
    if (!app.isPackaged) {
      settingsWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Close-to-menubar: hide instead of destroy, UNLESS app is actually quitting.
  settingsWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      settingsWindow?.hide();
    }
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  void settingsWindow.loadURL(getWindowUrl("settings"));
}

export function closeSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.hide();
  }
}

// ── Logs Window ───────────────────────────────────────────────────────────────

let logsWindow: BrowserWindow | null = null;

export function openLogs(): void {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.show();
    logsWindow.focus();
    return;
  }

  logsWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: "Plaud Obsidian Note Taker — Logs",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  logsWindow.on("ready-to-show", () => {
    logsWindow?.show();
    if (!app.isPackaged) {
      logsWindow?.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Close-to-menubar, unless app is actually quitting.
  logsWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      logsWindow?.hide();
    }
  });

  logsWindow.on("closed", () => {
    logsWindow = null;
  });

  void logsWindow.loadURL(getWindowUrl("logs"));
}

export function closeLogs(): void {
  if (logsWindow && !logsWindow.isDestroyed()) {
    logsWindow.hide();
  }
}

// ── Keyboard shortcut: Cmd-, → open Settings ─────────────────────────────────

/**
 * Register a global application menu.
 *
 * In LSUIElement apps the menu is invisible, but macOS still routes keyboard
 * shortcuts through it. We need an Edit submenu with the standard roles so
 * Cmd+C / Cmd+V / Cmd+X / Cmd+A / Cmd+Z work inside Settings and Logs
 * windows — without the Edit submenu the renderer silently drops paste events.
 */
export function registerSettingsShortcut(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            openSettings();
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "close" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}
