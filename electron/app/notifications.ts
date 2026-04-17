/**
 * Native notification wrapper for the Plaud Obsidian Note Taker.
 *
 * - Uses Electron's Notification API (grouped by CFBundleIdentifier set in forge.config.js).
 * - First launch: fires a one-time "ready" notification to trigger macOS permission prompt.
 * - Always logs [notifications] fired: {title} so behavior is visible in terminal
 *   even when macOS suppresses the toast (common in dev/unsigned builds — Pitfall 7).
 */

import { Notification, shell } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../src/log/core.js";
import { onNoteSaved, onError } from "./service.js";

/** Shape of a saved-note event dispatched from the service. */
export interface NoteSavedPayload {
  title: string;
  filePath: string;
  folder: string;
}

/** Shape of an error event dispatched from the service. */
export interface ErrorPayload {
  title: string;
  message: string;
}

/** Sentinel filename written to userDataDir on first launch. */
const FIRST_LAUNCH_SENTINEL = ".notifications-first-launch";

/**
 * Initialize notifications.
 * On first launch, fires a silent "ready" notification to trigger the macOS permission prompt.
 * Call once at app startup (after app.whenReady()).
 */
export function initNotifications(userDataDir: string): void {
  if (!Notification.isSupported()) {
    log("[notifications] Notification API not supported on this platform");
    return;
  }

  const sentinelPath = join(userDataDir, FIRST_LAUNCH_SENTINEL);
  if (!existsSync(sentinelPath)) {
    // First launch — fire a silent notification to prompt for permission
    try {
      writeFileSync(sentinelPath, new Date().toISOString(), { mode: 0o600 });
    } catch (err) {
      log("[notifications] failed to write first-launch sentinel:", err);
    }

    const readyNotif = new Notification({
      title: "Plaud Obsidian Note Taker",
      body: "Running in your menu bar. Click the icon to get started.",
      silent: true,
    });
    log("[notifications] fired: Plaud Obsidian Note Taker (first-launch ready)");
    readyNotif.show();
  }
}

/**
 * Fire a "New note saved" notification.
 * Clicking the notification opens the note in Obsidian.
 */
export function notifyNoteSaved(note: NoteSavedPayload): void {
  if (!Notification.isSupported()) return;

  const notif = new Notification({
    title: `New note saved: ${note.title}`,
    body: note.folder,
    silent: false,
  });

  notif.on("click", () => {
    const encodedPath = encodeURIComponent(note.filePath);
    shell.openExternal(`obsidian://open?path=${encodedPath}`).catch((err: unknown) => {
      log("[notifications] failed to open obsidian URL:", err);
    });
  });

  log(`[notifications] fired: New note saved: ${note.title}`);
  notif.show();
}

/**
 * Initialize notifications and subscribe service events to native toasts.
 * Call once at app startup (after app.whenReady() and after service is started).
 * Returns unsubscribe functions (call on before-quit if cleanup is needed).
 */
export function setupNotifications(userDataDir: string): { unsubscribe: () => void } {
  initNotifications(userDataDir);

  const unsubNoteSaved = onNoteSaved((payload) => {
    notifyNoteSaved(payload);
  });

  const unsubError = onError((payload) => {
    notifyError(payload);
  });

  return {
    unsubscribe: () => {
      unsubNoteSaved();
      unsubError();
    },
  };
}

/**
 * Fire a pipeline error notification.
 */
export function notifyError(args: { title: string; message: string }): void {
  if (!Notification.isSupported()) return;

  const notif = new Notification({
    title: args.title,
    body: args.message,
    silent: false,
  });

  log(`[notifications] fired: ${args.title}`);
  notif.show();
}
