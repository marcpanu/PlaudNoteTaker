/**
 * Popover window factory.
 *
 * Owns the BrowserWindow lifecycle for the menubar popover:
 * - Frameless, always-on-top, 320px wide, height fits content
 * - Anchored below the tray icon (centered horizontally)
 * - Auto-hides on blur (unless DevTools is open — preserve debugging)
 * - Loaded via getWindowUrl("popover")
 */

import { BrowserWindow, Tray, app, ipcMain, screen } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Popover width range. Two-line note rows (filename + muted dir path) mean we
// don't need much width even for deeply-nested vault paths — cap at ~540 for
// a compact macOS menubar feel.
const POPOVER_MIN_WIDTH = 320;
const POPOVER_MAX_WIDTH = 540;
// Height range: keep at least enough for header+footer+a few rows; cap so a
// huge vault doesn't push the popover off the bottom of the screen.
const POPOVER_MIN_HEIGHT = 200;
const POPOVER_MAX_HEIGHT = 800;

// ── URL resolver ───────────────────────────────────────────────────────────────
// Mirrors the pattern in windows.ts; duplicated here to avoid modifying that
// file beyond the minimal "popover" entry we add to getWindowUrl.
// We import getWindowUrl from windows.ts (which will have "popover" case).
import { getWindowUrl } from "./windows.js";

// ── Window singleton ───────────────────────────────────────────────────────────

let popoverWindow: BrowserWindow | null = null;
// Timestamp of the most recent hide-triggered-by-blur. The tray click handler
// uses this to avoid the racy "click tray → blur hides popover → click handler
// re-opens it immediately" loop on macOS.
let lastHiddenByBlurAt = 0;

const POPOVER_HEIGHT = 480;

function createPopoverWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: POPOVER_MIN_WIDTH,
    height: POPOVER_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    // Visible on every macOS Space (including full-screen apps). Without this,
    // the popover is pinned to whichever Space it was first opened on — the
    // user reported it failed to open while a different Space was focused.
    visibleOnAllWorkspaces: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Make popover follow the user across Spaces (including full-screen workspaces).
  // setVisibleOnAllWorkspaces must be called with visibleOnFullScreen for the
  // full-screen Space case specifically — the constructor flag alone isn't enough.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Auto-hide when the user clicks outside — window-level blur fires when
  // another app/window becomes active. Skip hiding when DevTools is open
  // (dev convenience — otherwise inspecting the popover closes it).
  win.on("blur", () => {
    if (win.isDestroyed()) return;
    if (win.webContents.isDevToolsOpened()) return;
    // Also track the last-hidden timestamp so the tray click handler can
    // distinguish "user clicked away, then clicked the tray" (don't reopen
    // immediately) from "user actually wants to re-toggle".
    lastHiddenByBlurAt = Date.now();
    win.hide();
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

  // show() (not showInactive) so the window actually receives focus —
  // required for the blur event to fire when the user clicks outside.
  popoverWindow.show();
  // LSUIElement apps don't automatically become the active app. Steal focus
  // so keypresses (e.g., Cmd-Q) target our app and so subsequent blur events
  // fire correctly.
  app.focus({ steal: true });
  popoverWindow.focus();
}

export function togglePopover(tray: Tray): void {
  if (isPopoverVisible()) {
    hidePopover();
    return;
  }
  // If blur just hid the popover (< 300 ms ago), don't reopen it — the user
  // clicked the tray to dismiss, not to re-toggle. Without this guard, click
  // on the tray fires blur (hide) then the click handler reopens immediately.
  if (Date.now() - lastHiddenByBlurAt < 300) {
    return;
  }
  showPopover(tray);
}

/**
 * IPC: renderer measures needed content width after render and requests a
 * resize. Clamped to [POPOVER_MIN_WIDTH, POPOVER_MAX_WIDTH]. Height is left
 * alone (renderer scrolls internally when the list is tall).
 */
ipcMain.handle(
  "window:resize-popover",
  (_event, req: { width: number; height: number }) => {
    if (!popoverWindow || popoverWindow.isDestroyed()) return { ok: false };
    const width = Math.max(
      POPOVER_MIN_WIDTH,
      Math.min(POPOVER_MAX_WIDTH, Math.round(req.width)),
    );
    const height = Math.max(
      POPOVER_MIN_HEIGHT,
      Math.min(POPOVER_MAX_HEIGHT, Math.round(req.height)),
    );
    const bounds = popoverWindow.getBounds();
    popoverWindow.setBounds({ ...bounds, width, height });
    return { ok: true, width, height };
  },
);
