import { contextBridge, ipcRenderer } from "electron";
import type {
  PlaudApi,
  SetConfigRequest,
  TestConnectionRequest,
  PickDirectoryRequest,
  SetDaemonEnabledRequest,
  DeleteSpeakerRequest,
  OpenInObsidianRequest,
  SetLoginEnabledRequest,
  RunMigrationRequest,
  RendererLogEvent,
  DaemonState,
  ConfigEditable,
  RecentNote,
} from "./ipc.js";

const plaudApi: PlaudApi = {
  // ---- Config ----
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (req: SetConfigRequest) => ipcRenderer.invoke("config:set", req),
  testConnection: (req: TestConnectionRequest) =>
    ipcRenderer.invoke("config:test-connection", req),
  pickDirectory: (req: PickDirectoryRequest) =>
    ipcRenderer.invoke("config:pick-directory", req),
  isConfigComplete: () => ipcRenderer.invoke("config:is-complete"),

  // ---- Daemon ----
  getDaemonState: () => ipcRenderer.invoke("daemon:get-state"),
  pollNow: () => ipcRenderer.invoke("daemon:poll-now"),
  setDaemonEnabled: (req: SetDaemonEnabledRequest) =>
    ipcRenderer.invoke("daemon:set-enabled", req),
  isDaemonEnabled: () => ipcRenderer.invoke("daemon:is-enabled"),

  // ---- Speakers ----
  listSpeakers: () => ipcRenderer.invoke("speakers:list"),
  deleteSpeaker: (req: DeleteSpeakerRequest) =>
    ipcRenderer.invoke("speakers:delete", req),

  // ---- Recent notes ----
  recentNotes: () => ipcRenderer.invoke("notes:recent"),
  openInObsidian: (req: OpenInObsidianRequest) =>
    ipcRenderer.invoke("notes:open-in-obsidian", req),

  // ---- Logs ----
  getLogBuffer: () => ipcRenderer.invoke("logs:get-buffer"),

  // ---- Launch at login ----
  getLoginEnabled: () => ipcRenderer.invoke("login:get-enabled"),
  setLoginEnabled: (req: SetLoginEnabledRequest) =>
    ipcRenderer.invoke("login:set-enabled", req),

  // ---- Migration ----
  migrationStatus: () => ipcRenderer.invoke("migration:status"),
  runMigration: (req: RunMigrationRequest) =>
    ipcRenderer.invoke("migration:run", req),
  dismissMigration: () => ipcRenderer.invoke("migration:dismiss"),

  // ---- Windows ----
  openSettings: () => ipcRenderer.invoke("window:open-settings"),
  closeSettings: () => ipcRenderer.invoke("window:close-settings"),
  openLogs: () => ipcRenderer.invoke("window:open-logs"),
  closeLogs: () => ipcRenderer.invoke("window:close-logs"),
  resizePopover: (req: { width: number; height: number }) =>
    ipcRenderer.invoke("window:resize-popover", req),

  // ---- App lifecycle ----
  quit: () => ipcRenderer.invoke("app:quit"),

  // ---- Push events (main → renderer) ----
  onLog: (handler: (ev: RendererLogEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: RendererLogEvent) =>
      handler(payload);
    ipcRenderer.on("event:log", listener);
    return () => ipcRenderer.off("event:log", listener);
  },

  onDaemonState: (handler: (s: DaemonState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: DaemonState) =>
      handler(payload);
    ipcRenderer.on("event:daemon-state", listener);
    return () => ipcRenderer.off("event:daemon-state", listener);
  },

  onConfigChanged: (handler: (c: ConfigEditable) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: ConfigEditable) =>
      handler(payload);
    ipcRenderer.on("event:config-changed", listener);
    return () => ipcRenderer.off("event:config-changed", listener);
  },

  onRecentNotesUpdated: (handler: (notes: RecentNote[]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: RecentNote[]) =>
      handler(payload);
    ipcRenderer.on("event:recent-notes-updated", listener);
    return () => ipcRenderer.off("event:recent-notes-updated", listener);
  },
};

try {
  contextBridge.exposeInMainWorld("plaudApi", plaudApi);
  console.log("[preload] plaudApi exposed on window");
} catch (err) {
  console.error("[preload] contextBridge.exposeInMainWorld failed:", err);
}
