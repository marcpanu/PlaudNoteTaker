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
const btnQuit = document.getElementById("btn-quit") as HTMLButtonElement;

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

/**
 * Split a vault-relative note path into a display pair:
 *   `01 Current Projects/Peregrine Integration/2026-04-17 Q2 Review.md`
 * becomes:
 *   filename: `Q2 Review.md`
 *   dirPath:  `01 Current Projects/Peregrine Integration/2026-04-17`
 *
 * When the basename starts with a `YYYY-MM-DD ` date prefix (our writer's
 * convention), the date is lifted to the end of the directory line so the
 * filename shows just the meaningful title.
 */
function splitNoteDisplay(fullPath: string): { filename: string; dirPath: string } {
  const slash = fullPath.lastIndexOf("/");
  const dir = slash >= 0 ? fullPath.slice(0, slash) : "";
  const basename = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;

  const dateMatch = basename.match(/^(\d{4}-\d{2}-\d{2}) (.+)$/);
  if (dateMatch) {
    const date = dateMatch[1];
    const rest = dateMatch[2];
    return {
      filename: rest,
      dirPath: dir ? `${dir}/${date}` : date,
    };
  }
  return { filename: basename, dirPath: dir };
}

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
    row.title = note.filePath;

    const full = note.vaultRelativePath || note.recordingName;
    const { filename, dirPath } = splitNoteDisplay(full);

    // Line 1: filename (prominent)
    const nameEl = document.createElement("div");
    nameEl.className = "note-row__name";
    nameEl.textContent = filename;

    // Line 2: directory path (muted, smaller)
    const pathEl = document.createElement("div");
    pathEl.className = "note-row__path";
    pathEl.textContent = dirPath;

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
    row.appendChild(nameEl);
    if (dirPath) row.appendChild(pathEl);
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

  // After layout settles, ask main to resize the popover to fit the longest
  // visible note name (title paths can get quite long). requestAnimationFrame
  // ensures scrollWidth reflects the just-inserted content.
  requestAnimationFrame(() => {
    resizePopoverToFit();
  });
}

/**
 * Measure the intrinsic content size and ask main to resize the window.
 * Width: widest note-row__name + padding.
 * Height: body.scrollHeight with the notes section's max-height lifted so
 *         intrinsic height is visible to the measurement.
 * Main clamps width to [320, 960] and height to [200, 800].
 */
function resizePopoverToFit(): void {
  if (typeof window.plaudApi.resizePopover !== "function") return;

  // Width — intrinsic text width of the widest visible line across all rows
  // (filename or path — each on its own line, but they share the same row width).
  const textEls = notesList.querySelectorAll<HTMLElement>(
    ".note-row__name, .note-row__path",
  );
  let maxTextWidth = 0;
  const prev: string[] = [];
  textEls.forEach((el, i) => {
    prev[i] = el.style.whiteSpace;
    el.style.whiteSpace = "nowrap";
    maxTextWidth = Math.max(maxTextWidth, el.scrollWidth);
  });
  textEls.forEach((el, i) => {
    el.style.whiteSpace = prev[i] ?? "";
  });

  // Height — briefly lift the notes-section max-height so the body's true
  // intrinsic height is visible to the measurement, then restore.
  const notesSection = document.querySelector<HTMLElement>(".notes-section");
  const prevMaxHeight = notesSection?.style.maxHeight ?? "";
  if (notesSection) notesSection.style.maxHeight = "none";
  const intrinsicHeight = document.body.scrollHeight;
  if (notesSection) notesSection.style.maxHeight = prevMaxHeight;

  const desiredWidth = maxTextWidth + 48;
  // Height already includes header + list + footer. No extra padding needed.
  const desiredHeight = intrinsicHeight;

  window.plaudApi
    .resizePopover({ width: desiredWidth, height: desiredHeight })
    .catch((err) => {
      console.error("[popover] resizePopover error:", err);
    });
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
  window.plaudApi.openSettings().catch((err) => {
    console.error("[popover] openSettings error:", err);
  });
});

btnLogs.addEventListener("click", () => {
  window.plaudApi.openLogs().catch((err) => {
    console.error("[popover] openLogs error:", err);
  });
});

btnQuit.addEventListener("click", () => {
  window.plaudApi.quit().catch((err) => {
    console.error("[popover] quit error:", err);
  });
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
