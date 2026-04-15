import { config } from "./config.js";
import { PlaudClient } from "./plaud/client.js";
import { loadProcessedIds, saveProcessedId } from "./state.js";
import { processRecording } from "./pipeline.js";

async function poll(plaudClient: PlaudClient): Promise<void> {
  const processedIds = loadProcessedIds(config.dataDir);

  let newRecordings;
  try {
    newRecordings = await plaudClient.getNewRecordings(processedIds);
  } catch (error) {
    console.error("Failed to fetch recordings:", error);
    return;
  }

  if (newRecordings.length === 0) return;

  console.log(`Found ${newRecordings.length} new recording(s)`);

  for (const recording of newRecordings) {
    try {
      await processRecording(recording, plaudClient);
      saveProcessedId(config.dataDir, recording.id);
    } catch (error) {
      console.error(
        `Failed to process recording "${recording.filename}":`,
        error,
      );
    }
  }
}

async function main(): Promise<void> {
  console.log("PlaudeNoteTaker starting...");
  console.log(`  Vault: ${config.vaultPath}/${config.vaultNotesFolder}`);
  console.log(`  Poll interval: ${config.pollInterval / 1000}s`);
  console.log(`  Gemini model: ${config.geminiModel}`);
  console.log(
    `  Speaker recognition: ${config.picovoiceAccessKey ? "enabled" : "disabled"}`,
  );

  const plaudClient = new PlaudClient(config.plaudBearerToken);

  console.log("Testing Plaud connection...");
  const connected = await plaudClient.testConnection();
  if (!connected) {
    console.error(
      "Failed to connect to Plaud API. Check your bearer token.",
    );
    process.exit(1);
  }
  console.log("Plaud connection OK");

  // Run initial poll immediately
  await poll(plaudClient);

  // Start polling loop
  console.log(`\nPolling every ${config.pollInterval / 1000}s...`);
  setInterval(() => {
    poll(plaudClient).catch((error) =>
      console.error("Poll error:", error),
    );
  }, config.pollInterval);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
