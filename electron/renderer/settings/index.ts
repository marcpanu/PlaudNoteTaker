/**
 * Settings window renderer — vanilla TypeScript, no framework.
 *
 * Tab state persisted via URL hash + localStorage key "settings:lastTab".
 * All IPC goes through window.plaudApi (contextBridge).
 */

import type { ConfigEditable, ApiProvider } from "../../ipc.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id) as T | null;
  if (!e) throw new Error(`Element #${id} not found`);
  return e;
}

function qs<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`Selector "${sel}" not found`);
  return e;
}

function show(e: HTMLElement): void { e.classList.remove("hidden"); }
function hide(e: HTMLElement): void { e.classList.add("hidden"); }

// ──────────────────────────────────────────────
// Tab routing
// ──────────────────────────────────────────────

const TAB_IDS = ["api-keys", "vault", "polling", "speakers", "about"] as const;
type TabId = typeof TAB_IDS[number];

const LS_KEY = "settings:lastTab";

function activateTab(tabId: TabId): void {
  // Update sidebar links
  document.querySelectorAll<HTMLAnchorElement>(".sidebar__item").forEach((a) => {
    const t = a.dataset["tab"] as TabId;
    a.classList.toggle("active", t === tabId);
  });
  // Show/hide panels
  TAB_IDS.forEach((id) => {
    const panel = document.getElementById(`tab-${id}`);
    if (panel) panel.classList.toggle("hidden", id !== tabId);
  });
  // If switching to speakers, refresh list
  if (tabId === "speakers") loadSpeakers();
  // Persist
  localStorage.setItem(LS_KEY, tabId);
}

function resolveInitialTab(): TabId {
  const hash = location.hash.replace("#", "").trim() as TabId;
  if (TAB_IDS.includes(hash)) return hash;
  const stored = localStorage.getItem(LS_KEY) as TabId | null;
  if (stored && TAB_IDS.includes(stored)) return stored;
  return "api-keys";
}

// ──────────────────────────────────────────────
// State
// ──────────────────────────────────────────────

// Snapshot of saved config from main process
let savedConfig: Partial<ConfigEditable> = {};

// In-progress edits (field name → current UI value)
const edits: Partial<ConfigEditable> & { pollIntervalSec?: number; geminiModel?: string } = {};

// ──────────────────────────────────────────────
// Dirty + validation
// ──────────────────────────────────────────────

/** Fields we treat as required for Save to be enabled. */
const REQUIRED_FIELDS: Array<keyof ConfigEditable> = [
  "plaudBearerToken",
  "assemblyAiApiKey",
  "geminiApiKey",
  "vaultPath",
  "vaultNotesFolder",
];

function getFormValues(): Partial<ConfigEditable> {
  const pollIntervalSec = parseInt(
    (document.getElementById("pollInterval") as HTMLInputElement)?.value ?? "",
    10,
  );
  return {
    plaudBearerToken: (document.getElementById("plaudBearerToken") as HTMLInputElement).value.trim(),
    assemblyAiApiKey: (document.getElementById("assemblyAiApiKey") as HTMLInputElement).value.trim(),
    geminiApiKey: (document.getElementById("geminiApiKey") as HTMLInputElement).value.trim(),
    picovoiceAccessKey: (document.getElementById("picovoiceAccessKey") as HTMLInputElement).value.trim(),
    vaultPath: (document.getElementById("vaultPath") as HTMLInputElement).value.trim(),
    vaultNotesFolder: (document.getElementById("vaultNotesFolder") as HTMLInputElement).value.trim(),
    templatesPath: (document.getElementById("templatesPath") as HTMLInputElement).value.trim(),
    selectedTemplate: (document.getElementById("selectedTemplate") as HTMLInputElement).value.trim(),
    pollInterval: !isNaN(pollIntervalSec) ? pollIntervalSec * 1000 : savedConfig.pollInterval,
    geminiModel: (document.getElementById("geminiModel") as HTMLInputElement).value.trim() || "gemini-2.5-flash",
  };
}

function isDirty(): boolean {
  const current = getFormValues();
  for (const key of Object.keys(current) as Array<keyof typeof current>) {
    if (current[key] !== (savedConfig as Record<string, unknown>)[key]) return true;
  }
  return false;
}

function isValid(): boolean {
  const vals = getFormValues();
  // Required non-empty string fields
  for (const f of REQUIRED_FIELDS) {
    const v = vals[f];
    if (!v || (typeof v === "string" && v.trim() === "")) return false;
  }
  // pollInterval numeric and in range
  const pi = vals.pollInterval;
  if (typeof pi !== "number" || isNaN(pi) || pi < 10_000 || pi > 3_600_000) return false;
  return true;
}

function updateSaveButton(): void {
  const saveBtn = el("btn-save");
  (saveBtn as HTMLButtonElement).disabled = !(isValid() && isDirty());
}

// ──────────────────────────────────────────────
// Populate fields from saved config
// ──────────────────────────────────────────────

function populateFields(config: Partial<ConfigEditable>): void {
  function set(id: string, val: unknown): void {
    const inp = document.getElementById(id) as HTMLInputElement | null;
    if (!inp) return;
    inp.value = val !== undefined && val !== null ? String(val) : "";
  }

  set("plaudBearerToken", config.plaudBearerToken ?? "");
  set("assemblyAiApiKey", config.assemblyAiApiKey ?? "");
  set("geminiApiKey", config.geminiApiKey ?? "");
  set("picovoiceAccessKey", config.picovoiceAccessKey ?? "");
  set("vaultPath", config.vaultPath ?? "");
  set("vaultNotesFolder", config.vaultNotesFolder ?? "");
  set("templatesPath", config.templatesPath ?? "");
  set("selectedTemplate", config.selectedTemplate ?? "");
  // pollInterval stored as ms; display as seconds
  const piSec = typeof config.pollInterval === "number" ? config.pollInterval / 1000 : 300;
  set("pollInterval", piSec);
  set("geminiModel", config.geminiModel ?? "gemini-2.5-flash");
}

// ──────────────────────────────────────────────
// Migration banner
// ──────────────────────────────────────────────

async function checkMigration(): Promise<void> {
  try {
    const status = await window.plaudApi.migrationStatus();
    const banner = el("migration-banner");
    if (status.kind === "source_found") {
      el("migration-banner-text").textContent = ` Found existing config at ${status.envPath}.`;
      show(banner);
      // Wire up buttons with the found paths
      el("btn-migration-import").onclick = async () => {
        if (status.kind !== "source_found") return;
        hide(banner);
        const result = await window.plaudApi.runMigration({
          envPath: status.envPath,
          dataDirPath: status.dataDirPath,
        });
        if (result.kind === "complete") {
          await loadConfig();
        } else if (result.kind === "failed") {
          showStatus(`Migration failed: ${result.error}`, "error");
          show(banner);
        }
      };
      el("btn-migration-fresh").onclick = async () => {
        hide(banner);
        await window.plaudApi.dismissMigration();
      };
    }
  } catch {
    // Non-fatal — main process may not have migration wired yet
  }
}

// ──────────────────────────────────────────────
// Config-incomplete banner
// ──────────────────────────────────────────────

async function checkConfigComplete(): Promise<void> {
  try {
    const result = await window.plaudApi.isConfigComplete();
    if (!result.complete && result.missing.length > 0) {
      el("incomplete-banner-text").textContent =
        ` Missing required fields: ${result.missing.join(", ")}.`;
      show(el("incomplete-banner"));
    } else {
      hide(el("incomplete-banner"));
    }
  } catch {
    // Non-fatal
  }
}

// ──────────────────────────────────────────────
// Load config from main process
// ──────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  try {
    const config = await window.plaudApi.getConfig();
    savedConfig = config ?? {};
    populateFields(savedConfig);
    updateSaveButton();
    await checkConfigComplete();
  } catch (err) {
    showStatus(`Failed to load config: ${String(err)}`, "error");
  }
}

// ──────────────────────────────────────────────
// Save
// ──────────────────────────────────────────────

async function save(): Promise<void> {
  const saveBtn = el<HTMLButtonElement>("btn-save");
  saveBtn.disabled = true;
  showStatus("Saving…", "info");

  try {
    const updates = getFormValues();
    const result = await window.plaudApi.setConfig({ updates });
    if (result.ok) {
      savedConfig = { ...savedConfig, ...updates };
      showStatus("Saved.", "saved");
      updateSaveButton();
      await checkConfigComplete();
    } else {
      const msgs = result.errors ? Object.values(result.errors).join("; ") : "Unknown error";
      showStatus(`Save failed: ${msgs}`, "error");
      saveBtn.disabled = false;
    }
  } catch (err) {
    showStatus(`Save failed: ${String(err)}`, "error");
    saveBtn.disabled = false;
  }
}

function showStatus(msg: string, kind: "info" | "saved" | "error"): void {
  const el2 = el("save-status");
  el2.textContent = msg;
  el2.className = "footer__status" + (kind === "saved" ? " footer__status--saved" : kind === "error" ? " footer__status--error" : "");
}

// ──────────────────────────────────────────────
// Test Connection
// ──────────────────────────────────────────────

async function testConnection(provider: ApiProvider, keyFieldId: string): Promise<void> {
  const resultEl = document.getElementById(`test-result-${provider}`);
  if (!resultEl) return;

  show(resultEl);
  resultEl.className = "test-result test-result--loading";
  resultEl.textContent = " Testing…";

  const keyInput = document.getElementById(keyFieldId) as HTMLInputElement | null;
  const key = keyInput?.value.trim() || undefined;

  try {
    const res = await window.plaudApi.testConnection({ provider, key });
    resultEl.className = `test-result test-result--${res.ok ? "ok" : "fail"}`;
    resultEl.textContent = (res.ok ? "✓ " : "✗ ") + res.message;
  } catch (err) {
    resultEl.className = "test-result test-result--fail";
    resultEl.textContent = "✗ " + String(err);
  }
}

// ──────────────────────────────────────────────
// Speakers
// ──────────────────────────────────────────────

async function loadSpeakers(): Promise<void> {
  const listEl = el("speakers-list");
  listEl.innerHTML = '<p class="speakers-empty">Loading…</p>';

  try {
    const speakers = await window.plaudApi.listSpeakers();
    if (speakers.length === 0) {
      listEl.innerHTML = '<p class="speakers-empty">No enrolled speakers.</p>';
      return;
    }
    listEl.innerHTML = "";
    for (const sp of speakers) {
      const row = document.createElement("div");
      row.className = "speaker-row";
      row.innerHTML = `
        <span class="speaker-row__name">${escapeHtml(sp.name)}</span>
        <button class="btn btn--danger btn--sm" type="button">Delete</button>
      `;
      const delBtn = row.querySelector<HTMLButtonElement>("button")!;
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Delete speaker profile for "${sp.name}"? This cannot be undone.`)) return;
        try {
          await window.plaudApi.deleteSpeaker({ name: sp.name });
          await loadSpeakers();
        } catch (err) {
          alert(`Failed to delete speaker: ${String(err)}`);
        }
      });
      listEl.appendChild(row);
    }
  } catch (err) {
    listEl.innerHTML = `<p class="speakers-empty" style="color:var(--error)">Failed to load speakers: ${escapeHtml(String(err))}</p>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────────
// Launch at login toggle
// ──────────────────────────────────────────────

async function loadLaunchAtLogin(): Promise<void> {
  try {
    const res = await window.plaudApi.getLoginEnabled();
    const toggle = document.getElementById("launchAtLogin") as HTMLInputElement;
    if (toggle) toggle.checked = res.enabled;
  } catch {
    // Non-fatal
  }
}

// ──────────────────────────────────────────────
// Directory pickers
// ──────────────────────────────────────────────

async function pickDirectory(title: string, targetFieldId: string): Promise<void> {
  const currentVal = (document.getElementById(targetFieldId) as HTMLInputElement)?.value || undefined;
  const res = await window.plaudApi.pickDirectory({ title, defaultPath: currentVal });
  if (res.path) {
    const inp = document.getElementById(targetFieldId) as HTMLInputElement;
    if (inp) {
      inp.value = res.path;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

// ──────────────────────────────────────────────
// Wire up all events
// ──────────────────────────────────────────────

function wireEvents(): void {
  // Sidebar tab clicks
  document.querySelectorAll<HTMLAnchorElement>(".sidebar__item").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const tabId = a.dataset["tab"] as TabId;
      if (tabId) {
        activateTab(tabId);
        history.replaceState(null, "", `#${tabId}`);
      }
    });
  });

  // hashchange (e.g. from Cmd-, re-opening to a specific tab)
  window.addEventListener("hashchange", () => {
    const hash = location.hash.replace("#", "") as TabId;
    if (TAB_IDS.includes(hash)) activateTab(hash);
  });

  // All text/number inputs → dirty check
  document.querySelectorAll<HTMLInputElement>("input[type='text'], input[type='password'], input[type='number']").forEach((inp) => {
    inp.addEventListener("input", updateSaveButton);
  });

  // Show/hide password toggles
  document.querySelectorAll<HTMLButtonElement>(".btn-eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset["target"];
      if (!targetId) return;
      const inp = document.getElementById(targetId) as HTMLInputElement;
      if (!inp) return;
      inp.type = inp.type === "password" ? "text" : "password";
    });
  });

  // Test connection buttons
  document.querySelectorAll<HTMLButtonElement>(".btn-test").forEach((btn) => {
    btn.addEventListener("click", () => {
      const provider = btn.dataset["provider"] as ApiProvider;
      const keyField = btn.dataset["keyField"] ?? "";
      if (provider) testConnection(provider, keyField);
    });
  });

  // Directory pickers
  document.getElementById("btn-pick-vault")?.addEventListener("click", () =>
    pickDirectory("Select Obsidian Vault Folder", "vaultPath"));

  document.getElementById("btn-pick-templates")?.addEventListener("click", () =>
    pickDirectory("Select Templates Folder", "templatesPath"));

  // Save button
  el("btn-save").addEventListener("click", save);

  // Launch at login toggle
  const loginToggle = document.getElementById("launchAtLogin") as HTMLInputElement | null;
  loginToggle?.addEventListener("change", async () => {
    try {
      await window.plaudApi.setLoginEnabled({ enabled: loginToggle.checked });
    } catch (err) {
      showStatus(`Failed to update launch at login: ${String(err)}`, "error");
      loginToggle.checked = !loginToggle.checked; // revert
    }
  });

  // React to config changes pushed from main
  window.plaudApi.onConfigChanged((config) => {
    savedConfig = config;
    populateFields(config);
    updateSaveButton();
  });
}

// ──────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────

async function init(): Promise<void> {
  wireEvents();
  const initialTab = resolveInitialTab();
  activateTab(initialTab);
  await loadConfig();
  await loadLaunchAtLogin();
  await checkMigration();
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((err) => console.error("Settings init error:", err));
});
