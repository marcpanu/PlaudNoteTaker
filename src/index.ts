import { config } from "./config.js";

console.log("PlaudeNoteTaker starting...");
console.log(`  Vault: ${config.vaultPath}`);
console.log(`  Notes folder: ${config.vaultNotesFolder}`);
console.log(`  Poll interval: ${config.pollInterval / 1000}s`);
console.log(`  Gemini model: ${config.geminiModel}`);
console.log(`  Speaker recognition: ${config.picovoiceAccessKey ? "enabled" : "disabled"}`);
console.log(`  Data dir: ${config.dataDir}`);

// TODO: Initialize pipeline components and start polling loop
console.log("\nPipeline not yet implemented. Scaffold complete.");
