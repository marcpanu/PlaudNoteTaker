import { subscribe } from "./core.js";
import { consoleSink } from "./sink-console.js";

// Auto-subscribe the console sink at module load.
// CRITICAL for CLI behavior parity — without this, `npx tsx src/index.ts start` produces no output.
// Do NOT move this into an init() function. Phase 2's Electron main will additively subscribe(ipcSink).
subscribe(consoleSink);

export type { LogEvent, LogLevel, Sink } from "./types.js";
export { subscribe, emit, log, warn, error } from "./core.js";
export { consoleSink } from "./sink-console.js";
