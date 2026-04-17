/**
 * Tray icon + DaemonState binding.
 *
 * Listens for state changes and updates tray icon + tooltip accordingly.
 * Two states: idle (normal icon) and error (error icon, if available).
 */

import type { Tray } from "electron";
import { nativeImage } from "electron";
import { trayIconPath } from "./paths.js";
import type { DaemonState } from "../../electron/ipc.js";

let _tray: Tray | null = null;
let _lastState: DaemonState = { kind: "idle", lastPollAt: null, lastError: null };

/** Attach the icon-state manager to a tray instance. */
export function attach(tray: Tray): void {
  _tray = tray;
  applyState(_lastState);
}

/** Detach (called on before-quit). */
export function detach(): void {
  _tray = null;
}

/** Apply a new DaemonState to the tray icon + tooltip. */
export function applyState(state: DaemonState): void {
  _lastState = state;
  if (!_tray) return;

  const iconFile = state.kind === "error" ? "iconTemplate-error.png" : "iconTemplate.png";
  const iconP = trayIconPath({ state: state.kind === "error" ? "error" : "idle" });

  try {
    const icon = nativeImage.createFromPath(iconP);
    icon.setTemplateImage(true);
    _tray.setImage(icon);
  } catch {
    // Non-fatal: icon update failed
  }

  // Update tooltip
  let tooltip = "Plaud Obsidian Note Taker";
  if (state.kind === "error" && state.lastError) {
    tooltip = `Error: ${state.lastError}`;
  } else if (state.kind === "polling") {
    tooltip = "Plaud Obsidian Note Taker — polling…";
  } else if (state.lastPollAt) {
    tooltip = `Plaud Obsidian Note Taker — last poll: ${formatRelative(state.lastPollAt)}`;
  }
  _tray.setToolTip(tooltip);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(isoTs: string): string {
  const diff = Date.now() - new Date(isoTs).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}
