/**
 * SHIM: preserves the public import path `./log.js` for all existing callers.
 * Do not add logic here — it belongs in ./log/core.ts or ./log/sink-console.ts.
 *
 * Side effect on import: ./log/index.js auto-subscribes the console sink exactly once.
 */
export * from "./log/index.js";
