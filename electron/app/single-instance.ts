/**
 * Pidfile-based lock to coordinate between the Electron app and the CLI.
 *
 * On app startup: write PID to {dataDir}/plaud.lock with O_EXCL.
 * If lock exists and owner PID is alive: show dialog + exit(1).
 * On quit: unlink pidfile.
 *
 * CLI (src/cli/start.ts) acquires the same lock at startup, releases on shutdown.
 * Read-only CLI commands (init, test, label, speakers) bypass the lock.
 */

import { app, dialog } from "electron";
import {
  openSync,
  writeSync,
  closeSync,
  existsSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { getPaths } from "./paths.js";

let _pidfilePath: string | null = null;
let _acquired = false;

/**
 * Attempt to acquire the pidfile lock.
 * Returns true if acquired, false if blocked by another process.
 * Shows a blocking dialog and exits if another instance is detected.
 */
export async function acquireLock(): Promise<boolean> {
  const { pidfilePath, dataDir } = getPaths();
  _pidfilePath = pidfilePath;

  // Check if a lock file already exists
  if (existsSync(pidfilePath)) {
    // Read the existing PID
    let existingPid: number | null = null;
    try {
      const content = readFileSync(pidfilePath, "utf-8").trim();
      existingPid = parseInt(content, 10);
    } catch {
      // File is unreadable — stale lock, we can overwrite
    }

    if (existingPid !== null && !isNaN(existingPid)) {
      // Check if the process is still alive
      const alive = isProcessAlive(existingPid);
      if (alive) {
        // Show blocking dialog
        await dialog.showMessageBox({
          type: "warning",
          title: "Already Running",
          message: "Plaud Obsidian Note Taker cannot start",
          detail:
            `The CLI (plaud start) or another copy of the app is already running (PID ${existingPid}). ` +
            "Quit it first, then reopen the app.",
          buttons: ["OK"],
        });
        app.exit(1);
        return false;
      }
      // Stale lock from a crashed process — remove it
      try {
        unlinkSync(pidfilePath);
      } catch {
        // Already removed
      }
    }
  }

  // Write our PID with O_EXCL for atomic creation
  try {
    const fd = openSync(pidfilePath, "wx"); // 'wx' = O_WRONLY | O_CREAT | O_EXCL
    writeSync(fd, String(process.pid));
    closeSync(fd);
    _acquired = true;
    return true;
  } catch (err) {
    // O_EXCL failed — another process just created it
    const msg = err instanceof Error ? err.message : String(err);
    await dialog.showMessageBox({
      type: "warning",
      title: "Already Running",
      message: "Plaud Obsidian Note Taker cannot start",
      detail: `Failed to acquire lock: ${msg}. Another process may be running.`,
      buttons: ["OK"],
    });
    app.exit(1);
    return false;
  }
}

/** Release the pidfile on quit. */
export function releaseLock(): void {
  if (!_acquired || !_pidfilePath) return;
  try {
    if (existsSync(_pidfilePath)) {
      unlinkSync(_pidfilePath);
    }
    _acquired = false;
  } catch {
    // Non-fatal
  }
}

/** Check if a PID corresponds to a running process. */
function isProcessAlive(pid: number): boolean {
  try {
    // Sending signal 0 checks existence without killing the process
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
