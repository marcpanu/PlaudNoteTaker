import type { LogEvent, Sink } from "./types.js";

/**
 * Byte-for-byte reproduction of the original src/log.ts timestamp format.
 * Prefix shape: `[HH:MM:SS +N.Ns]` (24-hour, en-US locale, 1-decimal elapsed seconds).
 * Call shape: `console.*(prefix, message, ...rest)` — matches `log("msg", obj)` pretty-printing obj.
 */
function formatPrefix(ev: LogEvent): string {
  const elapsed = (ev.elapsedMs / 1000).toFixed(1);
  const now = new Date(ev.ts).toLocaleTimeString("en-US", { hour12: false });
  return `[${now} +${elapsed}s]`;
}

export const consoleSink: Sink = (ev) => {
  const prefix = formatPrefix(ev);
  switch (ev.level) {
    case "info":
      console.log(prefix, ev.message, ...ev.args);
      break;
    case "warn":
      console.warn(prefix, ev.message, ...ev.args);
      break;
    case "error":
      console.error(prefix, ev.message, ...ev.args);
      break;
  }
};
