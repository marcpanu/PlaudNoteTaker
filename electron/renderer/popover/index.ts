/**
 * Popover window renderer — vanilla TypeScript, no framework.
 *
 * - Loads recent notes on mount via recentNotes()
 * - Subscribes to onRecentNotesUpdated for live updates from main
 * - Subscribes to onDaemonState for header dot + footer text
 * - Poll Now button triggers pollNow()
 * - Start/Stop toggle reads isDaemonEnabled() and calls setDaemonEnabled()
 * - Settings/Logs buttons open their respective windows
 */

import type { RecentNote, DaemonState } from "../../ipc.js";

// ── DOM refs ───────────────────────────────────────────────────────────────────

const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const notesList = document.getElementById("notes-list") as HTMLDivElement;
const notesEmpty = document.getElementById("notes-empty") as HTMLDivElement;
const footerPoll = document.getElementById("footer-poll") as HTMLSpanElement;
const footerError = document.getElementById("footer-error") as HTMLSpanElement;
const btnPollNow = document.getElementById("btn-poll-now") as HTMLButtonElement;
const btnToggleDaemon = document.getElementById("btn-toggle-daemon") as HTMLButtonElement;
const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const btnLogs = document.getElementById("btn-logs") as HTMLButtonElement;

// ── State ──────────────────────────────────────────────────────────────────────

let daemonEnabled = true;

// ── Relative-time formatter ────────────────────────────────────────────────────

function relativeTime(isoString: string): string {
  try {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffMs = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffSec < 60) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDay === 1) return "yesterday";
    return `${diffDay}d ago`;
  } catch {
    return "—";
  }
}

// ── Notes rendering ────────────────────────────────────────────────────────────

function renderNotes(notes: RecentNote[]): void {
  notesList.innerHTML = "";

  if (notes.length === 0) {
    notesEmpty.classList.remove("hidden");
    notesList.classList.add("hidden");
    return;
  }

  notesEmpty.classList.add("hidden");
  notesList.classList.remove("hidden");

  for (const note of notes) {
    const row = document.createElement("div");
    row.className = "note-row";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");

    const name = document.createElement("div");
    name.className = "note-row__name";
    // Show vault-relative path if available, fall back to recording name
    name.textContent = note.vaultRelativePath || note.recordingName;
    name.title = note.filePath;

    const meta = document.createElement("div");
    meta.className = "note-row__meta";

    const time = document.createElement("span");
    time.className = "note-row__time";
    time.textContent = relativeTime(note.processedAt);

    const status = document.createElement("span");
    status.className = `note-row__status note-row__status--${note.status}`;
    status.textContent = note.status;

    meta.appendChild(time);
    meta.appendChild(status);
    row.appendChild(name);
    row.appendChild(meta);

    // Click → open in Obsidian
    const openNote = (): void => {
      window.plaudApi.openInObsidian({ filePath: note.filePath }).catch((err) => {
        console.error("[popover] openInObsidian error:", err);
      });
    };

    row.addEventListener("click", openNote);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openNote();
      }
    });

    notesList.appendChild(row);
  }
}

// ── Daemon state rendering ─────────────────────────────────────────────────────

function renderDaemonState(state: DaemonState): void {
  // Update status dot
  statusDot.className = "status-dot";
  statusDot.classList.add(`status-dot--${state.kind}`);
  statusDot.title = state.kind.charAt(0).toUpperCase() + state.kind.slice(1);

  // Footer: last poll
  if (state.lastPollAt) {
    footerPoll.textContent = `Last poll: ${relativeTime(state.lastPollAt)}`;
  } else {
    footerPoll.textContent = "Not polled yet";
  }

  // Footer: last error
  if (state.lastError) {
    footerError.textContent = `Error: ${state.lastError}`;
    footerError.classList.remove("hidden");
  } else {
    footerError.classList.add("hidden");
  }
}

function updateToggleButton(enabled: boolean): void {
  daemonEnabled = enabled;
  btnToggleDaemon.textContent = enabled ? "Stop" : "Start";
}

// ── Poll Now button ────────────────────────────────────────────────────────────

btnPollNow.addEventListener("click", () => {
  if (btnPollNow.disabled) return;

  btnPollNow.disabled = true;
  btnPollNow.classList.add("btn--polling");
  const origText = btnPollNow.textContent ?? "Poll Now";
  btnPollNow.textContent = "Polling…";

  window.plaudApi.pollNow()
    .then(() => {
      // Success — main will push updates via onRecentNotesUpdated
    })
    .catch((err) => {
      console.error("[popover] pollNow error:", err);
    })
    .finally(() => {
      btnPollNow.disabled = false;
      btnPollNow.classList.remove("btn--polling");
      btnPollNow.textContent = origText;
    });
});

// ── Start/Stop toggle ─────────────────────────────────────────────────────────

btnToggleDaemon.addEventListener("click", () => {
  const newEnabled = !daemonEnabled;
  btnToggleDaemon.disabled = true;

  window.plaudApi.setDaemonEnabled({ enabled: newEnabled })
    .then(() => {
      updateToggleButton(newEnabled);
    })
    .catch((err) => {
      console.error("[popover] setDaemonEnabled error:", err);
    })
    .finally(() => {
      btnToggleDaemon.disabled = false;
    });
});

// ── Settings / Logs buttons ───────────────────────────────────────────────────

btnSettings.addEventListener("click", () => {
  const api = window.plaudApi;
  if (typeof api.openSettings === "function") {
    api.openSettings().catch((err) => {
      console.error("[popover] openSettings error:", err);
    });
  } else {
    // Fallback: open-settings via window:open-settings channel is handled
    // in ipc-handlers.ts; preload should expose this method.
    console.warn("[popover] openSettings not available on plaudApi");
  }
});

btnLogs.addEventListener("click", () => {
  const api = window.plaudApi;
  if (typeof api.openLogs === "function") {
    api.openLogs().catch((err) => {
      console.error("[popover] openLogs error:", err);
    });
  } else {
    console.warn("[popover] openLogs not available on plaudApi");
  }
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Load initial recent notes
  try {
    const notes = await window.plaudApi.recentNotes();
    renderNotes(notes);
  } catch (err) {
    console.error("[popover] recentNotes error:", err);
    renderNotes([]);
  }

  // Load initial daemon state
  try {
    const state = await window.plaudApi.getDaemonState();
    renderDaemonState(state);
  } catch (err) {
    console.error("[popover] getDaemonState error:", err);
  }

  // Load initial enabled/disabled state
  try {
    const { enabled } = await window.plaudApi.isDaemonEnabled();
    updateToggleButton(enabled);
  } catch (err) {
    console.error("[popover] isDaemonEnabled error:", err);
  }

  // Subscribe to live updates from main
  window.plaudApi.onRecentNotesUpdated((notes) => {
    renderNotes(notes);
  });

  window.plaudApi.onDaemonState((state) => {
    renderDaemonState(state);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error("[popover] init error:", err));
});
