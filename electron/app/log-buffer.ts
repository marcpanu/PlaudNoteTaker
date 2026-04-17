/**
 * Ring buffer of the last 1000 log events.
 *
 * Subscribes to the src/log pub/sub and pushes serializable events to all
 * listening webContents via webContents.send('event:log', ev).
 *
 * Serialization rule: strip non-JSON-serializable members from args
 * (Error objects → String(err), functions → undefined → filtered out).
 */

import { webContents } from "electron";
import { subscribe } from "../../src/log/core.js";
import type { LogEvent } from "../../src/log/types.js";
import type { RendererLogEvent } from "../../electron/ipc.js";

const BUFFER_SIZE = 1000;
const buffer: RendererLogEvent[] = [];
let unsubscribe: (() => void) | null = null;

/**
 * Serialize a LogEvent to a RendererLogEvent (JSON-safe shape).
 */
function serialize(ev: LogEvent): RendererLogEvent {
  return {
    ts: new Date(ev.ts).toISOString(),
    elapsedMs: ev.elapsedMs,
    level: ev.level,
    message: ev.message,
    args: ev.args.map((a) => {
      if (a === null || a === undefined) return a;
      if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") return a;
      if (a instanceof Error) return String(a);
      if (typeof a === "function") return undefined;
      try {
        // Test if JSON-serializable; if not, coerce to string
        JSON.stringify(a);
        return a;
      } catch {
        return String(a);
      }
    }).filter((a) => a !== undefined),
  };
}

/**
 * Start subscribing to the log pub/sub. Safe to call multiple times (idempotent).
 */
export function attach(): void {
  if (unsubscribe) return;

  unsubscribe = subscribe((ev: LogEvent) => {
    const rendererEv = serialize(ev);

    // Push to ring buffer
    buffer.push(rendererEv);
    if (buffer.length > BUFFER_SIZE) {
      buffer.shift();
    }

    // Push to all open renderer windows
    for (const wc of webContents.getAllWebContents()) {
      try {
        wc.send("event:log", rendererEv);
      } catch {
        // Window may be destroyed; ignore
      }
    }
  });
}

/** Detach from pub/sub (called on app quit). */
export function detach(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

/** Return a copy of the current buffer for initial window population. */
export function getBuffer(): RendererLogEvent[] {
  return [...buffer];
}
