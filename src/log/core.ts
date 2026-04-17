import type { LogEvent, LogLevel, Sink } from "./types.js";

const START = Date.now();
const sinks = new Set<Sink>();

/** Subscribe a sink. Returns an unsubscribe function. */
export function subscribe(sink: Sink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * Emit a log event to all subscribed sinks.
 * Sink errors are swallowed so one broken sink cannot break the emit loop
 * (critical for Phase 2's IPC sink, which may throw before a window exists).
 */
export function emit(level: LogLevel, args: unknown[]): void {
  const first = args[0];
  const message = typeof first === "string" ? first : String(first);
  const rest = args.slice(1);
  const ev: LogEvent = {
    level,
    message,
    args: rest,
    ts: Date.now(),
    elapsedMs: Date.now() - START,
  };
  for (const sink of sinks) {
    try {
      sink(ev);
    } catch {
      /* never let a bad sink break emit */
    }
  }
}

/**
 * Legacy surface — signatures match the original src/log.ts verbatim.
 * All existing `import { log, warn, error } from "../log.js"` keep working.
 */
export function log(...args: unknown[]): void {
  emit("info", args);
}
export function warn(...args: unknown[]): void {
  emit("warn", args);
}
export function error(...args: unknown[]): void {
  emit("error", args);
}
