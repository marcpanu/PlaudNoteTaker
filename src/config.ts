import { config as loadDotenv } from "dotenv";
import { resolve } from "path";

loadDotenv();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  // Plaud
  plaudBearerToken: required("PLAUD_BEARER_TOKEN"),

  // AssemblyAI
  assemblyAiApiKey: required("ASSEMBLYAI_API_KEY"),

  // Gemini
  geminiApiKey: required("GEMINI_API_KEY"),
  geminiModel: optional("GEMINI_MODEL", "gemini-2.5-flash"),

  // Picovoice Eagle
  picovoiceAccessKey: optional("PICOVOICE_ACCESS_KEY", ""),

  // Obsidian vault
  vaultPath: required("VAULT_PATH"),
  vaultNotesFolder: optional("VAULT_NOTES_FOLDER", "Meeting Notes"),
  templatesPath: optional("TEMPLATES_PATH", ""),
  selectedTemplate: optional("SELECTED_TEMPLATE", "Default"),

  // Polling
  pollInterval: parseInt(optional("POLL_INTERVAL", "60"), 10) * 1000,

  // Local state
  dataDir: resolve(optional("DATA_DIR", "./data")),
} as const;
