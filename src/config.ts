import { config as loadDotenv } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";

// Only load .env if it exists (won't exist before `plaude init`)
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadDotenv({ path: envPath });
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Run 'plaude init' to set up.`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

/** Load full config. Throws if required vars are missing. */
export function loadConfig() {
  return {
    plaudBearerToken: required("PLAUD_BEARER_TOKEN"),
    assemblyAiApiKey: required("ASSEMBLYAI_API_KEY"),
    geminiApiKey: required("GEMINI_API_KEY"),
    geminiModel: optional("GEMINI_MODEL", "gemini-2.5-flash"),
    picovoiceAccessKey: optional("PICOVOICE_ACCESS_KEY", ""),
    vaultPath: required("VAULT_PATH"),
    vaultNotesFolder: optional("VAULT_NOTES_FOLDER", "Meeting Notes"),
    templatesPath: optional("TEMPLATES_PATH", ""),
    selectedTemplate: optional("SELECTED_TEMPLATE", "Default"),
    pollInterval: parseInt(optional("POLL_INTERVAL", "60"), 10) * 1000,
    dataDir: resolve(optional("DATA_DIR", "./data")),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
