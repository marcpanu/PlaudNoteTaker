/**
 * Popover window factory.
 *
 * Owns the BrowserWindow lifecycle for the menubar popover:
 * - Frameless, always-on-top, 320px wide, height fits content
 * - Anchored below the tray icon (centered horizontally)
 * - Auto-hides on blur (unless DevTools is open — preserve debugging)
 * - Loaded via getWindowUrl("popover")
 */

import { BrowserWindow, Tray, screen } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── URL resolver ───────────────────────────────────────────────────────────────
// Mirrors the pattern in windows.ts; duplicated here to avoid modifying that
// file beyond the minimal "popover" entry we add to getWindowUrl.
// We import getWindowUrl from windows.ts (which will have "popover" case).
import { getWindowUrl } from "./windows.js";

// ── Window singleton ───────────────────────────────────────────────────────────

let popoverWindow: BrowserWindow | null = null;

// Popover dimensions
const POPOVER_WIDTH = 320;
// Initial height — JS resize via IPC or content-size events keeps it snug.
// We use a fixed reasonable height; the window is not resizable.
const POPOVER_HEIGHT = 480;

function createPopoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Auto-hide on blur — but not if DevTools is open (dev convenience)
  win.on("blur", () => {
    if (!win.isDestroyed() && !win.webContents.isDevToolsOpened()) {
      win.hide();
    }
  });

  win.on("closed", () => {
    popoverWindow = null;
  });

  void win.loadURL(getWindowUrl("popover"));

  return win;
}

// ── Positioning ────────────────────────────────────────────────────────────────

/**
 * Position the popover window below the tray icon, centered horizontally over it.
 * Falls back gracefully if tray bounds are unavailable.
 */
function positionPopover(win: BrowserWindow, tray: Tray): void {
  const trayBounds = tray.getBounds();
  const winBounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  const { workArea } = display;

  // Center horizontally over the tray icon
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  // Place below the tray icon (macOS menubar is at top)
  let y = Math.round(trayBounds.y + trayBounds.height + 4);

  // Keep within work area bounds
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - winBounds.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - winBounds.height));

  win.setBounds({ x, y, width: winBounds.width, height: winBounds.height });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function isPopoverVisible(): boolean {
  return popoverWindow !== null && !popoverWindow.isDestroyed() && popoverWindow.isVisible();
}

export function hidePopover(): void {
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    popoverWindow.hide();
  }
}

export function showPopover(tray: Tray): void {
  if (!popoverWindow || popoverWindow.isDestroyed()) {
    popoverWindow = createPopoverWindow();
  }

  positionPopover(popoverWindow, tray);

  if (!popoverWindow.isVisible()) {
    popoverWindow.showInactive();
  }
  popoverWindow.focus();
}

export function togglePopover(tray: Tray): void {
  if (isPopoverVisible()) {
    hidePopover();
  } else {
    showPopover(tray);
  }
}
