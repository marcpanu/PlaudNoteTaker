/**
 * Logs window renderer — vanilla TypeScript, no framework.
 *
 * - Initial buffer from getLogBuffer()
 * - Live entries via onLog subscription
 * - Auto-scroll unless user scrolled up
 * - Copy all entries to clipboard
 */

import type { RendererLogEvent } from "../../ipc.js";

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

const logBuffer: RendererLogEvent[] = [];
let autoScroll = true;

// ──────────────────────────────────────────────
// DOM refs
// ──────────────────────────────────────────────

const container = document.getElementById("log-container") as HTMLDivElement;
const entryCount = document.getElementById("entry-count") as HTMLSpanElement;
const scrollIndicator = document.getElementById("scroll-indicator") as HTMLSpanElement;
const btnCopy = document.getElementById("btn-copy") as HTMLButtonElement;
const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Returns true if the container is scrolled to (or near) the bottom. */
function isAtBottom(): boolean {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
}

function updateCount(): void {
  const n = logBuffer.length;
  entryCount.textContent = `${n} ${n === 1 ? "entry" : "entries"}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `[${hh}:${mm}:${ss}]`;
  } catch {
    return "[--:--:--]";
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  return `+${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildEntryEl(ev: RendererLogEvent): HTMLDivElement {
  const row = document.createElement("div");
  row.className = `log-entry log-entry--${ev.level}`;

  const ts = document.createElement("span");
  ts.className = "log-entry__ts";
  ts.textContent = formatTimestamp(ev.ts);

  const elapsed = document.createElement("span");
  elapsed.className = "log-entry__elapsed";
  elapsed.textContent = formatElapsed(ev.elapsedMs);

  const level = document.createElement("span");
  level.className = `log-entry__level log-entry__level--${ev.level}`;
  level.textContent = ev.level;

  const msg = document.createElement("span");
  msg.className = "log-entry__message";

  // Build message from ev.message + any extra args
  const parts: string[] = [ev.message];
  for (const arg of ev.args) {
    if (arg !== null && arg !== undefined) {
      parts.push(typeof arg === "string" ? arg : JSON.stringify(arg));
    }
  }
  msg.textContent = parts.join(" ");

  row.appendChild(ts);
  row.appendChild(elapsed);
  row.appendChild(level);
  row.appendChild(msg);
  return row;
}

function appendEntry(ev: RendererLogEvent): void {
  logBuffer.push(ev);
  const el = buildEntryEl(ev);
  container.appendChild(el);
  updateCount();

  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderAll(): void {
  container.innerHTML = "";
  for (const ev of logBuffer) {
    container.appendChild(buildEntryEl(ev));
  }
  updateCount();
  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

// ──────────────────────────────────────────────
// Auto-scroll management
// ──────────────────────────────────────────────

container.addEventListener("scroll", () => {
  const atBottom = isAtBottom();
  if (atBottom !== autoScroll) {
    autoScroll = atBottom;
    scrollIndicator.classList.toggle("visible", !autoScroll);
  }
});

// ──────────────────────────────────────────────
// Copy button
// ──────────────────────────────────────────────

btnCopy.addEventListener("click", async () => {
  const text = logBuffer
    .map((ev) => {
      const ts = formatTimestamp(ev.ts);
      const elapsed = formatElapsed(ev.elapsedMs);
      const parts = [ev.message, ...ev.args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))];
      return `${ts} ${elapsed} ${ev.level.toUpperCase()} ${parts.join(" ")}`;
    })
    .join("\n");

  try {
    await navigator.clipboard.writeText(text);
    btnCopy.classList.add("btn--copied");
    btnCopy.textContent = "Copied!";
    setTimeout(() => {
      btnCopy.classList.remove("btn--copied");
      btnCopy.textContent = "Copy Logs";
    }, 1500);
  } catch {
    btnCopy.textContent = "Copy failed";
    setTimeout(() => { btnCopy.textContent = "Copy Logs"; }, 1500);
  }
});

// ──────────────────────────────────────────────
// Clear button
// ──────────────────────────────────────────────

btnClear.addEventListener("click", () => {
  logBuffer.length = 0;
  container.innerHTML = "";
  updateCount();
});

// ──────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────

async function init(): Promise<void> {
  // Load historical buffer
  try {
    const initial = await window.plaudApi.getLogBuffer();
    for (const ev of initial) {
      logBuffer.push(ev);
    }
    renderAll();
  } catch (err) {
    console.error("Failed to load log buffer:", err);
  }

  // Subscribe to live events
  window.plaudApi.onLog((ev) => {
    appendEntry(ev);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error("Logs init error:", err));
});
