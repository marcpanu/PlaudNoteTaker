/**
 * Keychain-backed API key storage via Electron safeStorage.
 *
 * CRITICAL: app.setName('Plaud Obsidian Note Taker') MUST be called at the very top
 * of main.ts BEFORE this module is imported/used (Pitfall 7). This ensures the Keychain
 * entry is named "Plaud Obsidian Note Taker Safe Storage" rather than "Chromium Safe Storage".
 *
 * Encrypted blobs are stored in {userDataDir}/secrets.json as { [key]: base64(encrypted) }.
 * File is created with permissions 0600 (owner read/write only).
 */

import { safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { getPaths } from "./paths.js";

export type SecretKey =
  | "PLAUD_BEARER_TOKEN"
  | "ASSEMBLYAI_API_KEY"
  | "GEMINI_API_KEY"
  | "PICOVOICE_ACCESS_KEY";

type SecretsStore = Record<string, string>; // key → base64(encrypted)

function loadStore(): SecretsStore {
  const { secretsJsonPath } = getPaths();
  if (!existsSync(secretsJsonPath)) return {};
  try {
    return JSON.parse(readFileSync(secretsJsonPath, "utf-8")) as SecretsStore;
  } catch {
    return {};
  }
}

function saveStore(store: SecretsStore): void {
  const { secretsJsonPath } = getPaths();
  const json = JSON.stringify(store, null, 2);
  writeFileSync(secretsJsonPath, json, { mode: 0o600 });
  // Ensure permissions on every save in case file existed with wrong perms
  try {
    chmodSync(secretsJsonPath, 0o600);
  } catch {
    // non-fatal: we still wrote the file
  }
}

/**
 * Encrypt and persist a secret value under the given key.
 * Never logs the plaintext value — only logs "set secret X succeeded/failed".
 */
export async function setSecret(key: SecretKey, value: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("safeStorage: encryption not available");
  }
  const encrypted = safeStorage.encryptString(value);
  const store = loadStore();
  store[key] = encrypted.toString("base64");
  saveStore(store);
}

/**
 * Decrypt and return the secret value, or null if not set.
 * Never logs the plaintext value.
 */
export async function getSecret(key: SecretKey): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    return null;
  }
  const store = loadStore();
  const encoded = store[key];
  if (!encoded) return null;
  try {
    const buf = Buffer.from(encoded, "base64");
    return safeStorage.decryptString(buf);
  } catch {
    // Decryption failure: key may have been encrypted under different identity
    return null;
  }
}

/** Remove a secret from the store. */
export async function deleteSecret(key: SecretKey): Promise<void> {
  const store = loadStore();
  delete store[key];
  saveStore(store);
}

/** Return all currently stored secret keys (not values). */
export async function listSecretKeys(): Promise<SecretKey[]> {
  const store = loadStore();
  return Object.keys(store) as SecretKey[];
}
