import { existsSync } from "fs";
import { loadConfig } from "../config.js";
import { PlaudClient } from "../plaud/client.js";
import { getVaultFolderTree } from "../notes/vault.js";
import { execSync } from "child_process";

export async function runTest(): Promise<void> {
  console.log("PlaudNoteTaker config test\n");

  // Check ffmpeg
  process.stdout.write("ffmpeg: ");
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    console.log("OK");
  } catch {
    console.log("NOT FOUND");
  }

  // Load config (will throw if required vars are missing)
  let config;
  try {
    config = loadConfig();
    console.log("Config: OK");
  } catch (error) {
    console.error(`Config: FAILED — ${error}`);
    process.exit(1);
  }

  // Test Plaud connection
  process.stdout.write("Plaud API: ");
  const plaudClient = new PlaudClient(config.plaudBearerToken);
  const connected = await plaudClient.testConnection();
  if (!connected) {
    console.log("FAILED — check your bearer token");
    process.exit(1);
  }
  const devices = await plaudClient.listDevices();
  console.log(
    `OK — ${devices.data_devices.length} device(s): ${devices.data_devices.map((d) => d.name).join(", ")}`,
  );

  // Check recordings count
  const recordings = await plaudClient.getRecordings(0, 1);
  console.log(`Recordings: ${recordings.data_file_total} total`);

  // Check vault path
  process.stdout.write("Vault path: ");
  if (existsSync(config.vaultPath)) {
    const folders = getVaultFolderTree(config.vaultPath);
    const folderCount = folders.split("\n").filter(Boolean).length;
    console.log(`OK — ${folderCount} folders found`);
  } else {
    console.log(`NOT FOUND — ${config.vaultPath}`);
  }

  // Check optional services
  console.log(`Picovoice: ${config.picovoiceAccessKey ? "configured" : "not configured (speaker recognition disabled)"}`);
  console.log(`Gemini model: ${config.geminiModel}`);
  console.log(`Poll interval: ${config.pollInterval / 1000}s`);
  console.log(`Fallback folder: ${config.vaultNotesFolder}`);

  console.log("\nAll checks passed. Run 'plaud start' to begin.");
}
