/**
 * Service facade — single mutation point for all poll/processing state.
 *
 * Reentrancy lock prevents concurrent poll ticks and label operations.
 * Wraps poll-loop.ts with config-aware start/stop/restart logic.
 */

import type { Config } from "../../src/config/types.js";
import type { DaemonState, LabelResult } from "../../electron/ipc.js";
import { log } from "../../src/log/core.js";
import * as loop from "./poll-loop.js";
import { parseUnknownSpeakers, applyLabels } from "../../src/notes/writer.js";
import { getRecordingMeta } from "../../src/state.js";
import { PlaudClient } from "../../src/plaud/client.js";
import { decodeToPcm } from "../../src/audio.js";
import {
  enrollSpeaker,
  profileToBase64,
  profileFromBase64,
  recognizeSpeakers,
} from "../../src/speakers/eagle.js";
import type { Utterance } from "../../src/transcription/assemblyai.js";
import { loadProfiles, saveProfiles } from "../../src/speakers/profiles.js";

// ── Event subscriptions (re-exported from poll-loop) ──────────────────────────

/** Subscribe to new-note events. Returns an unsubscribe fn. */
export const onNoteSaved = loop.onNoteSaved;

/** Subscribe to pipeline error events. Returns an unsubscribe fn. */
export const onError = loop.onError;

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

/** Get the current vault path from running config, or empty string if not configured. */
export function getVaultPath(): string {
  return _config?.vaultPath ?? "";
}

/**
 * Label speakers in a note: apply text replacements and enroll voices.
 * Mirrors the CLI `plaud label` command but uses the running config.
 * Returns LabelResult { ok, matched, enrolled }.
 */
export async function labelSpeakers(notePath: string): Promise<LabelResult> {
  if (!_config) {
    return { ok: false, matched: 0, enrolled: 0, error: "Daemon not configured" };
  }
  const config = _config;

  try {
    const labels = parseUnknownSpeakers(notePath);
    if (labels.size === 0) {
      return { ok: false, matched: 0, enrolled: 0, error: "No speaker labels found in note" };
    }

    applyLabels(notePath, labels);
    const matched = labels.size;
    let enrolled = 0;

    if (config.picovoiceAccessKey) {
      const meta = getRecordingMeta(config.dataDir, notePath);
      if (meta) {
        const plaudClient = new PlaudClient(config.plaudBearerToken);
        let audioBuffer: Buffer;
        try {
          audioBuffer = await plaudClient.downloadRecording(meta.recordingId);
        } catch (err) {
          log("[service] labelSpeakers: failed to download audio for enrollment:", err);
          return { ok: true, matched, enrolled: 0 };
        }

        const pcm = await decodeToPcm(audioBuffer, 16000);
        const profiles = loadProfiles(config.dataDir);

        for (const [label, name] of labels) {
          if (profiles[name]) {
            log(`[service] labelSpeakers: ${name} already enrolled, skipping`);
            continue;
          }
          const segments = meta.utterances
            .filter((u) => u.speaker === label)
            .map((u) => ({ startMs: u.start, endMs: u.end }));
          if (segments.length === 0) continue;

          try {
            const profile = enrollSpeaker(pcm, segments, config.picovoiceAccessKey, 16000);
            if (profile) {
              profiles[name] = profileToBase64(profile);
              enrolled++;
              log(`[service] labelSpeakers: enrolled ${name}`);
            }
          } catch (err) {
            log(`[service] labelSpeakers: enrollment failed for ${name}:`, err);
          }
        }

        saveProfiles(config.dataDir, profiles);
      } else {
        log("[service] labelSpeakers: no recording meta found, skipping enrollment");
      }
    }

    return { ok: true, matched, enrolled };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("[service] labelSpeakers error:", err);
    return { ok: false, matched: 0, enrolled: 0, error: msg };
  }
}

// ── Plugin-facing speaker operations (HTTP bridge) ────────────────────────────
// These mirror the CLI / poll-loop Eagle ops but take raw PCM + utterances from
// the plugin rather than a Plaud recording ID. The node-SDK eagle.ts is the
// single authority on profile bytes (web-SDK profiles are byte-incompatible —
// see scripts/test-cross-sdk-profile.ts).

/** Return the current API-key set, or null if daemon has no loaded config. */
export function getApiKeys(): {
  plaud: string;
  assemblyai: string;
  gemini: string;
  picovoice: string;
} | null {
  if (!_config) return null;
  return {
    plaud: _config.plaudBearerToken,
    assemblyai: _config.assemblyAiApiKey,
    gemini: _config.geminiApiKey,
    picovoice: _config.picovoiceAccessKey,
  };
}

/** Names of all currently-enrolled speaker profiles. */
export function listEnrolledSpeakers(): string[] {
  if (!_config) return [];
  const profiles = loadProfiles(_config.dataDir);
  return Object.keys(profiles);
}

/** Delete an enrolled speaker. Idempotent — returns true if something was removed. */
export function deleteEnrolledSpeaker(name: string): boolean {
  if (!_config) return false;
  const profiles = loadProfiles(_config.dataDir);
  if (!(name in profiles)) return false;
  delete profiles[name];
  saveProfiles(_config.dataDir, profiles);
  log(`[service] deleted speaker profile: ${name}`);
  return true;
}

/**
 * Enroll a new speaker from raw PCM (Int16Array, 16kHz mono).
 * The plugin's recording flow captures continuous audio; we treat the full
 * buffer as a single "voice segment" for Eagle. If enrollment doesn't reach
 * 100% (too little voice), returns { ok: false, feedback } with the partial %.
 */
export function enrollSpeakerFromPcm(
  name: string,
  pcm: Int16Array,
): { ok: boolean; feedback?: number; error?: string } {
  if (!_config) return { ok: false, error: "Daemon not configured" };
  if (!_config.picovoiceAccessKey) {
    return { ok: false, error: "Picovoice key not configured" };
  }
  const durationMs = (pcm.length / 16000) * 1000;
  const segments = [{ startMs: 0, endMs: durationMs }];
  try {
    const profile = enrollSpeaker(pcm, segments, _config.picovoiceAccessKey, 16000);
    if (!profile) {
      return { ok: false, error: "Enrollment did not reach 100% — need more voice data" };
    }
    const profiles = loadProfiles(_config.dataDir);
    profiles[name] = profileToBase64(profile);
    saveProfiles(_config.dataDir, profiles);
    log(`[service] enrolled speaker: ${name}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[service] enrollSpeakerFromPcm error:`, err);
    return { ok: false, error: msg };
  }
}

/**
 * Recognize speakers in PCM given AssemblyAI-style utterance ranges.
 * Returns a map of AssemblyAI speaker label → enrolled speaker name (only for
 * labels that matched an enrolled profile above the threshold).
 */
export function recognizeSpeakersFromPcm(
  pcm: Int16Array,
  utterances: Utterance[],
): Record<string, string> {
  if (!_config) return {};
  if (!_config.picovoiceAccessKey) return {};
  const profiles = loadProfiles(_config.dataDir);
  const names = Object.keys(profiles);
  if (names.length === 0) return {};

  const buffers = names.map((n) => profileFromBase64(profiles[n]));
  const map = recognizeSpeakers(pcm, utterances, names, buffers, _config.picovoiceAccessKey);
  return Object.fromEntries(map);
}
