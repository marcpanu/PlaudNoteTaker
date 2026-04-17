/**
 * Barrel for the config folder.
 * Public API preserved: callers import { loadConfig, Config } from "../config.js" (the shim).
 * Phase 2 will add loadConfigFromApp() alongside loadConfigFromEnv() and switch loadConfig()
 * to pick based on a runtime flag — do NOT preempt that signature here.
 */
export type { Config } from "./types.js";
export { loadConfigFromEnv } from "./env-loader.js";
export { loadConfigFromEnv as loadConfig } from "./env-loader.js";
