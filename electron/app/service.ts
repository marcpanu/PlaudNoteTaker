/**
 * Service facade — single mutation point for all poll/processing state.
 *
 * Reentrancy lock prevents concurrent poll ticks and label operations.
 * Wraps poll-loop.ts with config-aware start/stop/restart logic.
 */

import type { Config } from "../../src/config/types.js";
import type { DaemonState } from "../../electron/ipc.js";
import { log } from "../../src/log/core.js";
import * as loop from "./poll-loop.js";

// ── State ─────────────────────────────────────────────────────────────────────

let _config: Config | null = null;
let _enabled = false;

// ── Public API ────────────────────────────────────────────────────────────────

/** Start the daemon with a given config. */
export async function start(config: Config): Promise<void> {
  _config = config;
  _enabled = true;
  log("[service] starting with config");
  loop.start(config);
}

/** Stop the daemon. */
export async function stop(): Promise<void> {
  _enabled = false;
  log("[service] stopping");
  loop.stop();
}

/**
 * Restart the daemon with a new config.
 * If only non-critical fields changed (poll interval, template, etc.),
 * update in-place. If API keys or vault path changed, do a full restart.
 */
export async function restart(newConfig: Config): Promise<void> {
  const oldConfig = _config;
  _config = newConfig;

  if (!oldConfig) {
    await start(newConfig);
    return;
  }

  const criticalChanged =
    oldConfig.plaudBearerToken !== newConfig.plaudBearerToken ||
    oldConfig.assemblyAiApiKey !== newConfig.assemblyAiApiKey ||
    oldConfig.geminiApiKey !== newConfig.geminiApiKey ||
    oldConfig.vaultPath !== newConfig.vaultPath;

  if (criticalChanged) {
    log("[service] critical config changed — restarting");
    loop.stop();
    loop.start(newConfig);
  } else {
    log("[service] minor config update — updating in-place");
    loop.updateConfig(newConfig);
  }
}

/** Trigger an immediate poll. Returns when the tick completes. */
export async function pollNow(): Promise<void> {
  await loop.triggerNow();
}

/** Enable or disable the daemon. */
export async function setEnabled(enabled: boolean): Promise<void> {
  if (enabled && !_enabled) {
    _enabled = true;
    if (_config) {
      loop.start(_config);
    }
  } else if (!enabled && _enabled) {
    _enabled = false;
    loop.stop();
  }
}

/** Whether the daemon is currently enabled. */
export function isEnabled(): boolean {
  return _enabled;
}

/** Get the current daemon state (idle/polling/error). */
export function getState(): DaemonState {
  return loop.getState();
}
