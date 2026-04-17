/**
 * First-run migration from CLI repo layout to app userDataDir layout.
 *
 * Safety rules (Pitfall 5):
 * - Stage into {userDataDir}.migrating/ first; atomic rename on success
 * - Never modify source .env or data/ files
 * - Byte-for-byte file copy (fs.copyFileSync) — no JSON round-trip
 * - Sentinel file prevents re-migration on subsequent launches
 * - On any failure: leave .migrating/ for forensics; return { kind: 'failed' }
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { MigrationStatus } from "../../electron/ipc.js";
import { setSecret } from "./secrets.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MigrationSource {
  envPath: string;
  dataDirPath: string;
}

/**
 * Search for a .env + data/ pair in likely locations.
 * Returns null if nothing is found.
 */
export function detectSource(): MigrationSource | null {
  const candidates = [
    process.cwd(),
    // repo root relative to this compiled file: electron/app/migration.ts → repo root is ../../
    resolve(__dirname, "../../"),
  ];

  for (const dir of candidates) {
    const envPath = join(dir, ".env");
    const dataDirPath = join(dir, "data");
    if (existsSync(envPath) && existsSync(dataDirPath)) {
      return { envPath, dataDirPath };
    }
  }
  return null;
}

/**
 * Determine migration status without performing any mutation.
 */
export function status(userDataDir: string): MigrationStatus {
  const sentinelPath = join(userDataDir, ".migration-complete");
  if (existsSync(sentinelPath)) {
    return { kind: "none_needed" };
  }

  const source = detectSource();
  if (!source) {
    return { kind: "none_needed" };
  }

  return { kind: "source_found", envPath: source.envPath, dataDirPath: source.dataDirPath };
}

/**
 * Write the migration sentinel file, recording timestamp and source.
 */
function writeSentinel(userDataDir: string, source: MigrationSource, migratedAt: string): void {
  const sentinelPath = join(userDataDir, ".migration-complete");
  writeFileSync(
    sentinelPath,
    JSON.stringify({ migratedAt, source }, null, 2),
    "utf-8",
  );
}

/**
 * Perform the full migration atomically.
 *
 * Steps:
 * 1. Stage all files into {userDataDir}.migrating/
 * 2. Import secrets from .env into Keychain
 * 3. Write non-secret fields to .migrating/settings.json
 * 4. Byte-copy all *.json from data/ into .migrating/data/
 * 5. Atomic rename: existing userDataDir → .old-{ts}, .migrating → userDataDir
 * 6. Write sentinel
 */
export async function run(
  source: MigrationSource,
  userDataDir: string,
): Promise<MigrationStatus> {
  const stagingDir = `${userDataDir}.migrating`;
  const migratedAt = new Date().toISOString();

  try {
    // Clean up any previous failed staging
    if (existsSync(stagingDir)) {
      rmSync(stagingDir, { recursive: true, force: true });
    }

    // 1. Create staging directory structure
    const stagingDataDir = join(stagingDir, "data");
    mkdirSync(stagingDir, { recursive: true });
    mkdirSync(stagingDataDir, { recursive: true });

    // 2. Parse .env (dotenv handles KEY=value format)
    // Use require() for dotenv since it's a CJS module; createRequire is set above
    const dotenv = require("dotenv") as { parse: (src: string) => Record<string, string> };
    const envContent = readFileSync(source.envPath, "utf-8");
    const envVars = dotenv.parse(envContent);

    // Resolve relative paths in .env against the directory containing .env
    const envDir = dirname(resolve(source.envPath));

    function resolveEnvPath(value: string): string {
      if (!value) return value;
      if (value.startsWith("/")) return value;
      return resolve(envDir, value);
    }

    // 3. Import secrets into Keychain
    type SecretKey = Parameters<typeof setSecret>[0];
    const secretsToMigrate: Array<[SecretKey, string]> = [
      ["PLAUD_BEARER_TOKEN", envVars["PLAUD_BEARER_TOKEN"] ?? ""],
      ["ASSEMBLYAI_API_KEY", envVars["ASSEMBLYAI_API_KEY"] ?? ""],
      ["GEMINI_API_KEY", envVars["GEMINI_API_KEY"] ?? ""],
      ["PICOVOICE_ACCESS_KEY", envVars["PICOVOICE_ACCESS_KEY"] ?? ""],
    ];

    for (const [key, value] of secretsToMigrate) {
      if (value) {
        await setSecret(key, value);
        console.log(`[migration] set secret ${key} (${value.length} chars)`);
      }
    }

    // 4. Write non-secret fields to staging/settings.json
    const vaultPathRaw = envVars["VAULT_PATH"] ?? "";
    const templatesPathRaw = envVars["TEMPLATES_PATH"] ?? "";

    const settings = {
      vaultPath: vaultPathRaw ? resolveEnvPath(vaultPathRaw) : "",
      vaultNotesFolder: envVars["VAULT_NOTES_FOLDER"] ?? "Meeting Notes",
      templatesPath: templatesPathRaw ? resolveEnvPath(templatesPathRaw) : "",
      selectedTemplate: envVars["SELECTED_TEMPLATE"] ?? "Default",
      pollInterval: parseInt(envVars["POLL_INTERVAL"] ?? "60", 10),
      geminiModel: envVars["GEMINI_MODEL"] ?? "gemini-2.5-flash",
    };

    writeFileSync(
      join(stagingDir, "settings.json"),
      JSON.stringify(settings, null, 2),
      "utf-8",
    );
    console.log(`[migration] wrote settings.json: vaultPath=${settings.vaultPath}`);

    // 5. Byte-for-byte copy of data/*.json files (CRITICAL: no parse/stringify round-trip)
    let jsonFilesCopied = 0;
    const dataFiles = existsSync(source.dataDirPath)
      ? readdirSync(source.dataDirPath).filter((f) => f.endsWith(".json"))
      : [];

    for (const file of dataFiles) {
      const srcPath = join(source.dataDirPath, file);
      const dstPath = join(stagingDataDir, file);
      const srcSize = statSync(srcPath).size;
      copyFileSync(srcPath, dstPath);

      // Validate: parse the copy to catch corruption (speaker-profiles.json has binary base64 — skip parse validation)
      if (file !== "speaker-profiles.json") {
        try {
          JSON.parse(readFileSync(dstPath, "utf-8"));
        } catch (parseErr) {
          throw new Error(`JSON validation failed for ${file} after copy: ${String(parseErr)}`);
        }
      }

      const dstSize = statSync(dstPath).size;
      if (srcSize !== dstSize) {
        throw new Error(`Byte count mismatch for ${file}: src=${srcSize} dst=${dstSize}`);
      }
      console.log(`[migration] copied ${file}: ${srcSize} bytes`);
      jsonFilesCopied++;
    }
    console.log(`[migration] copied ${jsonFilesCopied} data files`);

    // 6. Atomic swap
    if (existsSync(userDataDir)) {
      const oldDir = `${userDataDir}.old-${Date.now()}`;
      renameSync(userDataDir, oldDir);
      console.log(`[migration] moved existing userDataDir to ${oldDir}`);
    }

    renameSync(stagingDir, userDataDir);
    console.log(`[migration] renamed .migrating → userDataDir`);

    // 7. Write sentinel
    writeSentinel(userDataDir, source, migratedAt);
    console.log(`[migration] wrote sentinel at ${migratedAt}`);

    return { kind: "complete", migratedAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[migration] FAILED: ${msg}`);
    // Leave staging dir for forensics — DO NOT clean up
    return { kind: "failed", error: msg };
  }
}

/**
 * Dismiss migration (write sentinel without migrating).
 * User chose "Start Fresh" — just prevent future migration prompts.
 */
export async function dismiss(userDataDir: string): Promise<void> {
  const migratedAt = new Date().toISOString();
  const sentinelPath = join(userDataDir, ".migration-complete");
  writeFileSync(
    sentinelPath,
    JSON.stringify({ migratedAt, dismissed: true }, null, 2),
    "utf-8",
  );
  console.log(`[migration] dismissed at ${migratedAt}`);
}
