import { loadConfig } from "../config.js";
import { PlaudClient } from "../plaud/client.js";
import {
  loadProcessedIds,
  saveProcessedId,
  addToHistory,
  getRecentHistory,
} from "../state.js";
import { processRecording } from "../pipeline.js";
import { log, warn, error } from "../log.js";

export async function runStart(): Promise<void> {
  const config = loadConfig();

  log("PlaudNoteTaker starting...");
  log(`  Vault: ${config.vaultPath}/${config.vaultNotesFolder}`);
  log(`  Poll interval: ${config.pollInterval / 1000}s`);
  log(`  Gemini model: ${config.geminiModel}`);
  log(
    `  Speaker recognition: ${config.picovoiceAccessKey ? "enabled" : "disabled"}`,
  );

  const plaudClient = new PlaudClient(config.plaudBearerToken);

  log("Testing Plaud connection...");
  const connected = await plaudClient.testConnection();
  if (!connected) {
    error("Failed to connect to Plaud API. Check your bearer token.");
    process.exit(1);
  }
  log("Plaud connection OK\n");

  // Run initial poll immediately
  await poll(plaudClient, config);

  // Start polling loop — skip if previous poll is still running
  let polling = false;
  log(`Polling every ${config.pollInterval / 1000}s...`);
  setInterval(() => {
    if (polling) {
      log("Previous poll still running, skipping...");
      return;
    }
    polling = true;
    poll(plaudClient, config)
      .catch((err) => error("Poll error:", err))
      .finally(() => { polling = false; });
  }, config.pollInterval);
}

async function poll(
  plaudClient: PlaudClient,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const processedIds = loadProcessedIds(config.dataDir);

  let newRecordings;
  try {
    newRecordings = await plaudClient.getNewRecordings(processedIds);
  } catch (err) {
    error("Failed to fetch recordings:", err);
    return;
  }

  if (newRecordings.length === 0) return;

  log(`Found ${newRecordings.length} new recording(s)`);

  let processedAny = false;

  for (const recording of newRecordings) {
    try {
      const filePath = await processRecording(recording, plaudClient, config);
      saveProcessedId(config.dataDir, recording.id);
      if (filePath) {
        addToHistory(config.dataDir, {
          filePath,
          recordingName: recording.filename,
          processedAt: new Date().toISOString(),
          status: "saved",
        });
        processedAny = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("no spoken audio")) {
        warn(`Skipping "${recording.filename}": no spoken audio detected`);
        saveProcessedId(config.dataDir, recording.id);
        addToHistory(config.dataDir, {
          filePath: "",
          recordingName: recording.filename,
          processedAt: new Date().toISOString(),
          status: "skipped",
        });
      } else {
        error(
          `Failed to process recording "${recording.filename}":`,
          err,
        );
      }
    }
  }

  if (processedAny) {
    printRecentSummary(config.dataDir);
  }
}

function printRecentSummary(dataDir: string): void {
  const recent = getRecentHistory(dataDir);
  if (recent.length === 0) return;

  const saved = recent.filter((e) => e.status === "saved");
  const skipped = recent.filter((e) => e.status === "skipped");

  log("\n══════════════════════════════════════════");
  log(`  Recent notes (past 72h): ${saved.length} saved, ${skipped.length} skipped`);
  log("══════════════════════════════════════════");

  for (const entry of saved) {
    const time = new Date(entry.processedAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    log(`  ${time}  ${entry.filePath}`);
  }

  if (skipped.length > 0) {
    log(`  (${skipped.length} recording(s) skipped — no spoken audio)`);
  }

  log("══════════════════════════════════════════\n");
}
