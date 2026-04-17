/**
 * SHIM: preserves the public import path `./config.js` for all existing callers.
 * Do not add logic here — it belongs in ./config/env-loader.ts or ./config/validate.ts.
 *
 * Rationale: under moduleResolution: Node16 + "type": "module", directory imports
 * (e.g. `from "./config"`) fail at runtime. Keeping config.ts as a file shim means
 * no caller has to change an import path.
 */
export * from "./config/index.js";
export type { Config } from "./config/index.js";
