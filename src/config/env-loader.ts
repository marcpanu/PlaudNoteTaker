import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
import type { Config } from "./types.js";
import { required, optional } from "./validate.js";

/**
 * Load Config from environment variables (CLI path).
 * Side effects (preserved from original src/config.ts):
 *   - If ./.env exists in cwd, loads it via dotenv WITHOUT override (shell env wins).
 *   - Throws on missing required keys; the error message is part of the CLI contract.
 *   - Returns a frozen object (immutable after load).
 */
export function loadConfigFromEnv(): Config {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
    // NOTE: no { override: true } — dotenv default (override: false) is part of the CLI contract.
  }

  const e = process.env;
  return Object.freeze({
    plaudBearerToken: required(e, "PLAUD_BEARER_TOKEN"),
    assemblyAiApiKey: required(e, "ASSEMBLYAI_API_KEY"),
    geminiApiKey: required(e, "GEMINI_API_KEY"),
    geminiModel: optional(e, "GEMINI_MODEL", "gemini-2.5-flash"),
    picovoiceAccessKey: optional(e, "PICOVOICE_ACCESS_KEY", ""),
    vaultPath: required(e, "VAULT_PATH"),
    vaultNotesFolder: optional(e, "VAULT_NOTES_FOLDER", "Meeting Notes"),
    templatesPath: optional(e, "TEMPLATES_PATH", ""),
    selectedTemplate: optional(e, "SELECTED_TEMPLATE", "Default"),
    pollInterval: parseInt(optional(e, "POLL_INTERVAL", "60"), 10) * 1000,
    dataDir: resolve(optional(e, "DATA_DIR", "./data")),
  });
}
