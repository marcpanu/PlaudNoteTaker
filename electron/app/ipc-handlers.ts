/**
 * IPC handler registration — one function wires every channel from electron/ipc.ts.
 * Imported and called once from main.ts after app.whenReady().
 */

import { ipcMain, dialog, shell } from "electron";
import type {
  SetConfigRequest,
  TestConnectionRequest,
  PickDirectoryRequest,
  SetDaemonEnabledRequest,
  DeleteSpeakerRequest,
  OpenInObsidianRequest,
  SetLoginEnabledRequest,
  RunMigrationRequest,
  DaemonState,
  RecentNote,
  SetConfigResponse,
} from "../../electron/ipc.js";
import { loadConfigFromApp, saveSettings, isConfigComplete } from "../../src/config/app-loader.js";
import { getSecret, setSecret } from "./secrets.js";
import type { SecretKey } from "./secrets.js";
import { getPaths } from "./paths.js";
import { getBuffer as getLogBuffer } from "./log-buffer.js";
import { getEnabled as getLoginEnabled, setEnabled as setLoginEnabled } from "./login-item.js";
import {
  getState as getDaemonState,
  setEnabled as setDaemonEnabled,
  isEnabled as isDaemonEnabled,
  pollNow,
} from "./service.js";
import { status as migrationStatus, run as runMigration, dismiss as dismissMigration } from "./migration.js";
import { openSettings, closeSettings, openLogs, closeLogs } from "./windows.js";
import { loadProfiles, saveProfiles } from "../../src/speakers/profiles.js";
import { getRecentHistory } from "../../src/state.js";
import { PlaudClient } from "../../src/plaud/client.js";
import { webContents } from "electron";

// Bound secret getter compatible with GetSecretFn in app-loader.ts
const secretGetter = (key: string) => getSecret(key as SecretKey);

export function registerIpcHandlers(): void {
  const { userDataDir, dataDir } = getPaths();

  // ── Config ──────────────────────────────────────────────────────────────────

  ipcMain.handle("config:get", async () => {
    const config = await loadConfigFromApp(userDataDir, secretGetter);
    if (!config) return null;
    // Strip internal dataDir field for ConfigEditable shape
    const { dataDir: _ignored, ...editable } = config;
    return editable;
  });

  ipcMain.handle("config:set", async (_event, req: SetConfigRequest) => {
    try {
      const { updates } = req;
      // Separate secrets from non-secret fields
      const secretMap: Record<string, string> = {};
      const nonSecretUpdates: Record<string, unknown> = {};

      for (const [k, v] of Object.entries(updates)) {
        if (typeof v !== "string" && typeof v !== "number") {
          nonSecretUpdates[k] = v;
          continue;
        }
        if (k === "plaudBearerToken") {
          secretMap["PLAUD_BEARER_TOKEN"] = String(v);
        } else if (k === "assemblyAiApiKey") {
          secretMap["ASSEMBLYAI_API_KEY"] = String(v);
        } else if (k === "geminiApiKey") {
          secretMap["GEMINI_API_KEY"] = String(v);
        } else if (k === "picovoiceAccessKey") {
          secretMap["PICOVOICE_ACCESS_KEY"] = String(v);
        } else {
          nonSecretUpdates[k] = v;
        }
      }

      // Save secrets to Keychain
      for (const [k, v] of Object.entries(secretMap)) {
        await setSecret(k as SecretKey, v);
      }

      // Save non-secret fields to settings.json
      if (Object.keys(nonSecretUpdates).length > 0) {
        // pollInterval from renderer comes as seconds (settings.json convention)
        await saveSettings(userDataDir, nonSecretUpdates as Parameters<typeof saveSettings>[1]);
      }

      // Emit config-changed to all renderers
      const newConfig = await loadConfigFromApp(userDataDir, secretGetter);
      if (newConfig) {
        const { dataDir: _ignored, ...editable } = newConfig;
        for (const wc of webContents.getAllWebContents()) {
          try { wc.send("event:config-changed", editable); } catch { /* ignore */ }
        }
      }

      return { ok: true } as SetConfigResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, errors: { _: msg } } as SetConfigResponse;
    }
  });

  ipcMain.handle("config:test-connection", async (_event, req: TestConnectionRequest) => {
    const { provider, key } = req;
    try {
      if (provider === "plaud") {
        const token = key ?? (await getSecret("PLAUD_BEARER_TOKEN")) ?? "";
        if (!token) return { ok: false, message: "No Plaud token configured" };
        const client = new PlaudClient(token);
        const ok = await client.testConnection();
        return { ok, message: ok ? "Connected to Plaud API" : "Failed to connect to Plaud API" };
      }
      if (provider === "assemblyai") {
        const apiKey = key ?? (await getSecret("ASSEMBLYAI_API_KEY")) ?? "";
        if (!apiKey) return { ok: false, message: "No AssemblyAI key configured" };
        const resp = await fetch("https://api.assemblyai.com/v2/transcript", {
          method: "GET",
          headers: { authorization: apiKey },
        });
        const ok = resp.status !== 401 && resp.status !== 403;
        return { ok, message: ok ? "AssemblyAI key accepted" : `AssemblyAI returned ${resp.status}` };
      }
      if (provider === "gemini") {
        const apiKey = key ?? (await getSecret("GEMINI_API_KEY")) ?? "";
        if (!apiKey) return { ok: false, message: "No Gemini key configured" };
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
        );
        const ok = resp.ok;
        return { ok, message: ok ? "Gemini key accepted" : `Gemini returned ${resp.status}` };
      }
      if (provider === "picovoice") {
        const apiKey = key ?? (await getSecret("PICOVOICE_ACCESS_KEY")) ?? "";
        if (!apiKey) return { ok: false, message: "No Picovoice key configured" };
        return { ok: true, message: "Picovoice key stored (no ping endpoint available)" };
      }
      return { ok: false, message: `Unknown provider: ${String(provider)}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("config:pick-directory", async (_event, req: PickDirectoryRequest) => {
    const result = await dialog.showOpenDialog({
      title: req.title,
      defaultPath: req.defaultPath,
      properties: ["openDirectory"],
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  ipcMain.handle("config:is-complete", async () => {
    return isConfigComplete(userDataDir, secretGetter);
  });

  // ── Daemon ───────────────────────────────────────────────────────────────────

  ipcMain.handle("daemon:get-state", async () => {
    return getDaemonState();
  });

  ipcMain.handle("daemon:poll-now", async () => {
    try {
      await pollNow();
      return { ok: true, message: "Poll triggered" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("daemon:set-enabled", async (_event, req: SetDaemonEnabledRequest) => {
    await setDaemonEnabled(req.enabled);
    return { ok: true };
  });

  ipcMain.handle("daemon:is-enabled", async () => {
    return { enabled: isDaemonEnabled() };
  });

  // ── Speakers ─────────────────────────────────────────────────────────────────

  ipcMain.handle("speakers:list", async () => {
    const profiles = loadProfiles(dataDir);
    return Object.keys(profiles).map((name) => ({ name }));
  });

  ipcMain.handle("speakers:delete", async (_event, req: DeleteSpeakerRequest) => {
    const profiles = loadProfiles(dataDir);
    delete profiles[req.name];
    saveProfiles(dataDir, profiles);
    return { ok: true };
  });

  // ── Recent Notes ─────────────────────────────────────────────────────────────

  ipcMain.handle("notes:recent", async () => {
    const history = getRecentHistory(dataDir, 72);
    const config = await loadConfigFromApp(userDataDir, secretGetter);
    const vaultPath = config?.vaultPath ?? "";
    const notes: RecentNote[] = history.map((e) => ({
      filePath: e.filePath,
      vaultRelativePath:
        vaultPath && e.filePath.startsWith(vaultPath)
          ? e.filePath.slice(vaultPath.length).replace(/^\//, "")
          : e.filePath,
      recordingName: e.recordingName,
      processedAt: e.processedAt,
      status: e.status,
    }));
    return notes;
  });

  ipcMain.handle("notes:open-in-obsidian", async (_event, req: OpenInObsidianRequest) => {
    const encodedPath = encodeURIComponent(req.filePath);
    await shell.openExternal(`obsidian://open?path=${encodedPath}`);
    return { ok: true };
  });

  // ── Logs ─────────────────────────────────────────────────────────────────────

  ipcMain.handle("logs:get-buffer", async () => {
    return getLogBuffer();
  });

  // ── Login Item ───────────────────────────────────────────────────────────────

  ipcMain.handle("login:get-enabled", async () => {
    return { enabled: getLoginEnabled() };
  });

  ipcMain.handle("login:set-enabled", async (_event, req: SetLoginEnabledRequest) => {
    setLoginEnabled(req.enabled);
    return { ok: true };
  });

  // ── Migration ────────────────────────────────────────────────────────────────

  ipcMain.handle("migration:status", async () => {
    return migrationStatus(userDataDir);
  });

  ipcMain.handle("migration:run", async (_event, req: RunMigrationRequest) => {
    return runMigration({ envPath: req.envPath, dataDirPath: req.dataDirPath }, userDataDir);
  });

  ipcMain.handle("migration:dismiss", async () => {
    await dismissMigration(userDataDir);
    return { ok: true };
  });

  // ── Windows ──────────────────────────────────────────────────────────────────

  ipcMain.handle("window:open-settings", async () => {
    openSettings();
    return { ok: true };
  });

  ipcMain.handle("window:close-settings", async () => {
    closeSettings();
    return { ok: true };
  });

  ipcMain.handle("window:close-logs", async () => {
    closeLogs();
    return { ok: true };
  });
}
