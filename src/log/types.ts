/**
 * Public types for the log pub/sub.
 * LogEvent is the canonical shape every sink receives; Phase 2's IPC sink will serialize these.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  readonly level: LogLevel;
  readonly message: string;              // pre-formatted primary message (first arg of log/warn/error)
  readonly args: readonly unknown[];     // extra args after the first, passed through to console.*
  readonly ts: number;                   // Date.now() at emit time
  readonly elapsedMs: number;            // ms since module import (proxy for process startup)
}

export type Sink = (ev: LogEvent) => void;
