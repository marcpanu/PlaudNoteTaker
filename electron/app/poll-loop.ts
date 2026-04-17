/**
 * Self-rescheduling poll loop (setTimeout, NOT setInterval — Pitfall 4).
 *
 * Each tick wraps its body in try/catch so one failure never terminates the chain.
 * powerMonitor 'resume' → debounced immediate retrigger (resume fires twice on some macOS — Pitfall 4).
 * powerMonitor 'suspend' → abort in-flight HTTP requests.
 */

import { powerMonitor, webContents } from "electron";
import type { Config } from "../../src/config/types.js";
import type { DaemonState } from "../../electron/ipc.js";
import { PlaudClient } from "../../src/plaud/client.js";
import { processRecording } from "../../src/pipeline.js";
import {
  loadProcessedIds,
  saveProcessedId,
  addToHistory,
} from "../../src/state.js";
import { log, warn, error } from "../../src/log/core.js";

// ── State ────────────────────────────────────────────────────────────────────

let _config: Config | null = null;
let _enabled = false;
let _pollTimer: ReturnType<typeof setTimeout> | null = null;
let _abortController: AbortController = new AbortController();
let _running = false; // reentrancy guard

let _daemonState: DaemonState = { kind: "idle", lastPollAt: null, lastError: null };

// ── Helpers ───────────────────────────────────────────────────────────────────

function emitDaemonState(state: DaemonState): void {
  _daemonState = state;
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send("event:daemon-state", state);
    } catch {
      // Window may be destroyed
    }
  }
}

function cancelTimer(): void {
  if (_pollTimer !== null) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}

function scheduleNext(delayMs: number): void {
  cancelTimer();
  _pollTimer = setTimeout(() => {
    void runTick();
  }, delayMs);
}

// ── Core tick ─────────────────────────────────────────────────────────────────

export async function runTick(): Promise<void> {
  if (!_enabled || !_config) return;
  if (_running) {
    log("[poll-loop] previous tick still running, deferring");
    scheduleNext(_config.pollInterval);
    return;
  }

  _running = true;
  _abortController = new AbortController();
  const config = _config;

  emitDaemonState({ kind: "polling", lastPollAt: _daemonState.lastPollAt, lastError: null });

  try {
    const plaudClient = new PlaudClient(config.plaudBearerToken);
    const processedIds = loadProcessedIds(config.dataDir);

    let newRecordings;
    try {
      newRecordings = await plaudClient.getNewRecordings(processedIds);
    } catch (err) {
      error("[poll-loop] failed to fetch recordings:", err);
      const msg = err instanceof Error ? err.message : String(err);
      emitDaemonState({ kind: "error", lastPollAt: _daemonState.lastPollAt, lastError: msg });
      scheduleNext(config.pollInterval);
      return;
    }

    if (newRecordings.length === 0) {
      log("[poll-loop] no new recordings");
    } else {
      log(`[poll-loop] found ${newRecordings.length} new recording(s)`);

      const recentNotes = [];

      for (const recording of newRecordings) {
        if (_abortController.signal.aborted) {
          log("[poll-loop] aborted mid-tick (suspend signal)");
          break;
        }

        try {
          const filePath = await processRecording(recording, plaudClient, config);
          saveProcessedId(config.dataDir, recording.id);
          if (filePath) {
            const entry = {
              filePath,
              recordingName: recording.filename,
              processedAt: new Date().toISOString(),
              status: "saved" as const,
            };
            addToHistory(config.dataDir, entry);
            recentNotes.push(entry);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("no spoken audio")) {
            warn(`[poll-loop] skipping "${recording.filename}": no spoken audio`);
            saveProcessedId(config.dataDir, recording.id);
            addToHistory(config.dataDir, {
              filePath: "",
              recordingName: recording.filename,
              processedAt: new Date().toISOString(),
              status: "skipped",
            });
          } else {
            error(`[poll-loop] failed to process "${recording.filename}":`, err);
          }
        }
      }

      // Push recent notes update to all renderers
      if (recentNotes.length > 0) {
        for (const wc of webContents.getAllWebContents()) {
          try {
            wc.send("event:recent-notes-updated", recentNotes);
          } catch {
            // Window may be destroyed
          }
        }
      }
    }

    const lastPollAt = new Date().toISOString();
    emitDaemonState({ kind: "idle", lastPollAt, lastError: null });
    scheduleNext(config.pollInterval);
  } catch (err) {
    // Per-tick catch: log error but always reschedule
    const msg = err instanceof Error ? err.message : String(err);
    error("[poll-loop] tick failed:", err);
    emitDaemonState({ kind: "error", lastPollAt: _daemonState.lastPollAt, lastError: msg });
    scheduleNext(config?.pollInterval ?? 60_000);
  } finally {
    _running = false;
  }
}

// ── Power monitor hooks ───────────────────────────────────────────────────────

let _resumeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function onSuspend(): void {
  log("[poll-loop] system suspending — aborting in-flight requests");
  _abortController.abort();
  cancelTimer();
}

function onResume(): void {
  // Debounce: macOS can fire 'resume' twice (Pitfall 4)
  if (_resumeDebounceTimer !== null) {
    clearTimeout(_resumeDebounceTimer);
  }
  _resumeDebounceTimer = setTimeout(() => {
    _resumeDebounceTimer = null;
    log("[poll-loop] system resumed — triggering immediate poll");
    cancelTimer();
    scheduleNext(500); // small delay to let network come up
  }, 500);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Start the poll loop with a given config. Also attaches powerMonitor hooks. */
export function start(config: Config): void {
  _config = config;
  _enabled = true;

  // Attach power monitor hooks (idempotent — register once only via the module-level setup below)
  cancelTimer();
  log(`[poll-loop] starting (interval=${config.pollInterval / 1000}s)`);
  void runTick();
}

/** Stop the poll loop. Cancel any pending timer, abort in-flight requests. */
export function stop(): void {
  _enabled = false;
  cancelTimer();
  _abortController.abort();
  log("[poll-loop] stopped");
  emitDaemonState({ kind: "idle", lastPollAt: _daemonState.lastPollAt, lastError: null });
}

/** Update config in-place without restarting the timer. */
export function updateConfig(config: Config): void {
  _config = config;
}

/** Trigger an immediate poll, ignoring the timer. */
export async function triggerNow(): Promise<void> {
  if (!_enabled || !_config) {
    throw new Error("Poll loop not running");
  }
  cancelTimer();
  await runTick();
}

/** Get the current daemon state (for IPC handler). */
export function getState(): DaemonState {
  return _daemonState;
}

// Attach powerMonitor hooks at module load time (idempotent)
powerMonitor.on("suspend", onSuspend);
powerMonitor.on("resume", onResume);
