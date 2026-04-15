import { loadConfig } from "../config.js";
import { PlaudClient } from "../plaud/client.js";
import { loadProcessedIds, saveProcessedId } from "../state.js";
import { processRecording } from "../pipeline.js";

export async function runStart(): Promise<void> {
  const config = loadConfig();

  console.log("PlaudNoteTaker starting...");
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
  console.log("Plaud connection OK\n");

  // Run initial poll immediately
  await poll(plaudClient, config);

  // Start polling loop
  console.log(`Polling every ${config.pollInterval / 1000}s...`);
  setInterval(() => {
    poll(plaudClient, config).catch((error) =>
      console.error("Poll error:", error),
    );
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
  } catch (error) {
    console.error("Failed to fetch recordings:", error);
    return;
  }

  if (newRecordings.length === 0) return;

  console.log(`Found ${newRecordings.length} new recording(s)`);

  for (const recording of newRecordings) {
    try {
      await processRecording(recording, plaudClient, config);
      saveProcessedId(config.dataDir, recording.id);
    } catch (error) {
      console.error(
        `Failed to process recording "${recording.filename}":`,
        error,
      );
    }
  }
}
