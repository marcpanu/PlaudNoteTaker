/**
 * App-mode config loader. Async equivalent of env-loader for the Electron main process.
 *
 * Reads non-secret settings from {userDataDir}/settings.json.
 * Reads secret fields via an injected getSecret function (implemented in electron/app/secrets.ts
 * using safeStorage — not accessible from src/ directly).
 *
 * Returns null if required fields are missing (caller opens Settings UI instead of crashing).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import type { Config } from "./types.js";

/** Shape returned by isConfigComplete (matches electron/ipc.ts IsConfigCompleteResponse). */
export interface IsConfigCompleteResult {
  complete: boolean;
  missing: string[];
}

// Type alias for the secret-getter injected from electron/app/secrets.ts
export type GetSecretFn = (key: string) => Promise<string | null>;

/** Non-secret fields persisted to {userDataDir}/settings.json */
export interface SettingsJson {
  vaultPath?: string;
  vaultNotesFolder?: string;
  templatesPath?: string;
  selectedTemplate?: string;
  /** Stored as seconds; Config.pollInterval is ms */
  pollInterval?: number;
  geminiModel?: string;
}

/** Subset of ConfigEditable that can be saved via saveSettings (no secrets). */
export type ConfigNonSecret = Pick<
  SettingsJson,
  "vaultPath" | "vaultNotesFolder" | "templatesPath" | "selectedTemplate" | "pollInterval" | "geminiModel"
>;

function loadSettingsJson(userDataDir: string): SettingsJson {
  const path = join(userDataDir, "settings.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SettingsJson;
  } catch {
    return {};
  }
}

/**
 * Load full Config from Keychain secrets (via injected getSecret) + settings.json.
 * Returns null if any required field is missing.
 *
 * @param userDataDir  - resolved path to ~/Library/Application Support/PlaudNoteTaker
 * @param getSecret    - injected getter from electron/app/secrets.ts
 */
export async function loadConfigFromApp(
  userDataDir: string,
  getSecret: GetSecretFn,
): Promise<Config | null> {
  const settings = loadSettingsJson(userDataDir);

  const plaudBearerToken = await getSecret("PLAUD_BEARER_TOKEN");
  const assemblyAiApiKey = await getSecret("ASSEMBLYAI_API_KEY");
  const geminiApiKey = await getSecret("GEMINI_API_KEY");
  const picovoiceAccessKey = await getSecret("PICOVOICE_ACCESS_KEY");

  // Required fields — return null if any are missing
  if (!plaudBearerToken) return null;
  if (!assemblyAiApiKey) return null;
  if (!geminiApiKey) return null;
  if (!settings.vaultPath) return null;

  return Object.freeze({
    plaudBearerToken,
    assemblyAiApiKey,
    geminiApiKey,
    geminiModel: settings.geminiModel ?? "gemini-2.5-flash",
    picovoiceAccessKey: picovoiceAccessKey ?? "",
    vaultPath: resolve(settings.vaultPath),
    vaultNotesFolder: settings.vaultNotesFolder ?? "Meeting Notes",
    templatesPath: settings.templatesPath ?? "",
    selectedTemplate: settings.selectedTemplate ?? "Default",
    pollInterval: (settings.pollInterval ?? 60) * 1000, // stored as seconds, Config wants ms
    dataDir: join(userDataDir, "data"),
  });
}

/**
 * Persist non-secret editable fields to settings.json.
 * Secret fields (plaudBearerToken, assemblyAiApiKey, etc.) are handled separately via secrets.ts.
 */
export async function saveSettings(
  userDataDir: string,
  partial: Partial<ConfigNonSecret>,
): Promise<void> {
  const existing = loadSettingsJson(userDataDir);
  const updated: SettingsJson = { ...existing };

  if (partial.vaultPath !== undefined) updated.vaultPath = partial.vaultPath;
  if (partial.vaultNotesFolder !== undefined) updated.vaultNotesFolder = partial.vaultNotesFolder;
  if (partial.templatesPath !== undefined) updated.templatesPath = partial.templatesPath;
  if (partial.selectedTemplate !== undefined) updated.selectedTemplate = partial.selectedTemplate;
  if (partial.geminiModel !== undefined) updated.geminiModel = partial.geminiModel;
  if (partial.pollInterval !== undefined) {
    // Settings UI sends pollInterval in ms (consistent with Config.pollInterval).
    // settings.json stores it in seconds to match env-loader's POLL_INTERVAL units
    // and what migration.ts wrote. Convert ms → s here.
    const ms = typeof partial.pollInterval === "number"
      ? partial.pollInterval
      : parseInt(String(partial.pollInterval), 10);
    if (!isNaN(ms)) {
      updated.pollInterval = Math.round(ms / 1000);
    }
  }

  const path = join(userDataDir, "settings.json");
  writeFileSync(path, JSON.stringify(updated, null, 2));
}

/**
 * Check which required config fields are missing.
 * Used by the Settings UI to show a "config incomplete" banner.
 */
export async function isConfigComplete(
  userDataDir: string,
  getSecret: GetSecretFn,
): Promise<IsConfigCompleteResult> {
  const settings = loadSettingsJson(userDataDir);
  const missing: string[] = [];

  const plaudBearerToken = await getSecret("PLAUD_BEARER_TOKEN");
  const assemblyAiApiKey = await getSecret("ASSEMBLYAI_API_KEY");
  const geminiApiKey = await getSecret("GEMINI_API_KEY");

  if (!plaudBearerToken) missing.push("plaudBearerToken");
  if (!assemblyAiApiKey) missing.push("assemblyAiApiKey");
  if (!geminiApiKey) missing.push("geminiApiKey");
  if (!settings.vaultPath) missing.push("vaultPath");

  return { complete: missing.length === 0, missing };
}
