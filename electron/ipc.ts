/**
 * IPC contract between main process and renderer(s).
 *
 * Single source of truth for every message crossing process boundary.
 * Both `electron/main.ts` (registers handlers) and `electron/preload.ts`
 * (exposes the API to renderers via contextBridge) must conform to this.
 *
 * Rule: every payload and return type is JSON-serializable. No Buffers,
 * no Date objects, no functions, no class instances. Timestamps are
 * ISO strings. Binary data is base64.
 */

import type { Config } from "../src/config/types.js";

// ---------- Shared types ----------

export type ConfigEditable = Omit<Config, "dataDir"> & {
  // Everything user-editable in Settings. dataDir is internal (resolved at startup),
  // not user-facing.
};

/** One log line pushed from main → renderer (ring-buffered in main). */
export interface RendererLogEvent {
  ts: string; // ISO timestamp
  elapsedMs: number;
  level: "info" | "warn" | "error";
  message: string;
  args: unknown[]; // JSON-serializable; main filters non-serializable members
}

/** Processing-history entry visible in popover/recent-notes. */
export interface RecentNote {
  filePath: string; // absolute path in vault
  vaultRelativePath: string; // path relative to vaultPath, for display
  recordingName: string;
  processedAt: string; // ISO timestamp
  status: "saved" | "skipped";
}

/** Enrolled speaker profile — name only; the encoded blob stays server-side. */
export interface EnrolledSpeaker {
  name: string;
}

/** Per-provider connection-test result. */
export interface ConnectionTestResult {
  ok: boolean;
  message: string; // success detail or human-readable error
}

export type ApiProvider = "plaud" | "assemblyai" | "gemini" | "picovoice";

/** Menubar icon + poll daemon state. Icon renders idle vs error. */
export type DaemonState =
  | { kind: "idle"; lastPollAt: string | null; lastError: null }
  | { kind: "polling"; lastPollAt: string | null; lastError: null }
  | { kind: "error"; lastPollAt: string | null; lastError: string };

/** First-run migration state. */
export type MigrationStatus =
  | { kind: "none_needed" } // sentinel file already present OR no source found
  | { kind: "source_found"; envPath: string; dataDirPath: string }
  | { kind: "in_progress" }
  | { kind: "complete"; migratedAt: string }
  | { kind: "failed"; error: string };

/** Result of the speaker-labeling flow (for Settings Speakers pane delete, reused by bridge in Phase 4). */
export interface LabelResult {
  ok: boolean;
  matched: number;
  enrolled: number;
  error?: string;
}

// ---------- IPC channel names ----------
// Pattern: `domain:action`. Every channel MUST appear in this union.

export type IpcChannel =
  // config
  | "config:get"
  | "config:set"
  | "config:test-connection"
  | "config:pick-directory"
  | "config:is-complete"
  // daemon / poll
  | "daemon:get-state"
  | "daemon:poll-now"
  | "daemon:set-enabled"
  | "daemon:is-enabled"
  // speakers
  | "speakers:list"
  | "speakers:delete"
  // recent notes
  | "notes:recent"
  | "notes:open-in-obsidian"
  // logs
  | "logs:get-buffer"
  // launch at login
  | "login:get-enabled"
  | "login:set-enabled"
  // migration
  | "migration:status"
  | "migration:run"
  | "migration:dismiss"
  // windows
  | "window:open-settings"
  | "window:close-settings"
  | "window:close-logs";

// One-way events pushed from main → renderer (not request/reply).
export type IpcEvent =
  | "event:log" // RendererLogEvent
  | "event:daemon-state" // DaemonState
  | "event:config-changed" // ConfigEditable
  | "event:recent-notes-updated"; // RecentNote[]

// ---------- Request / response payload shapes ----------
// Convention: request type = `XRequest`, response = `XResponse`. `void` where empty.

export type GetConfigRequest = void;
export type GetConfigResponse = ConfigEditable | null; // null when config incomplete

export interface SetConfigRequest {
  updates: Partial<ConfigEditable>;
}
export interface SetConfigResponse {
  ok: boolean;
  errors?: Record<string, string>; // field → validation message
}

export interface TestConnectionRequest {
  provider: ApiProvider;
  // Keys read from pending (un-saved) edits in the UI, passed in for live test-button flow.
  // When undefined, use the currently-saved key.
  key?: string;
}
export type TestConnectionResponse = ConnectionTestResult;

export interface PickDirectoryRequest {
  title: string;
  defaultPath?: string;
}
export type PickDirectoryResponse = { path: string | null }; // null = user cancelled

export type IsConfigCompleteRequest = void;
export interface IsConfigCompleteResponse {
  complete: boolean;
  missing: string[]; // keys of ConfigEditable that are required and empty
}

export type GetDaemonStateRequest = void;
export type GetDaemonStateResponse = DaemonState;

export type PollNowRequest = void;
export interface PollNowResponse {
  ok: boolean;
  message: string;
}

export interface SetDaemonEnabledRequest {
  enabled: boolean;
}
export type SetDaemonEnabledResponse = { ok: true };

export type IsDaemonEnabledRequest = void;
export type IsDaemonEnabledResponse = { enabled: boolean };

export type ListSpeakersRequest = void;
export type ListSpeakersResponse = EnrolledSpeaker[];

export interface DeleteSpeakerRequest {
  name: string;
}
export type DeleteSpeakerResponse = { ok: true };

export type RecentNotesRequest = void;
export type RecentNotesResponse = RecentNote[];

export interface OpenInObsidianRequest {
  filePath: string;
}
export type OpenInObsidianResponse = { ok: true };

export type GetLogBufferRequest = void;
export type GetLogBufferResponse = RendererLogEvent[];

export type GetLoginEnabledRequest = void;
export type GetLoginEnabledResponse = { enabled: boolean };

export interface SetLoginEnabledRequest {
  enabled: boolean;
}
export type SetLoginEnabledResponse = { ok: true };

export type MigrationStatusRequest = void;
export type MigrationStatusResponse = MigrationStatus;

export interface RunMigrationRequest {
  envPath: string;
  dataDirPath: string;
}
export type RunMigrationResponse = MigrationStatus;

export type DismissMigrationRequest = void;
export type DismissMigrationResponse = { ok: true };

export type OpenSettingsRequest = void;
export type OpenSettingsResponse = { ok: true };
export type CloseSettingsRequest = void;
export type CloseSettingsResponse = { ok: true };
export type CloseLogsRequest = void;
export type CloseLogsResponse = { ok: true };

// ---------- Bridge API exposed to renderer via contextBridge ----------
// `window.plaudApi` is typed with this shape. Preload calls ipcRenderer.invoke(channel, payload)
// and subscribes to ipcRenderer.on(event, handler) for pushed events.

export interface PlaudApi {
  // Config
  getConfig: () => Promise<GetConfigResponse>;
  setConfig: (req: SetConfigRequest) => Promise<SetConfigResponse>;
  testConnection: (req: TestConnectionRequest) => Promise<TestConnectionResponse>;
  pickDirectory: (req: PickDirectoryRequest) => Promise<PickDirectoryResponse>;
  isConfigComplete: () => Promise<IsConfigCompleteResponse>;

  // Daemon
  getDaemonState: () => Promise<GetDaemonStateResponse>;
  pollNow: () => Promise<PollNowResponse>;
  setDaemonEnabled: (req: SetDaemonEnabledRequest) => Promise<SetDaemonEnabledResponse>;
  isDaemonEnabled: () => Promise<IsDaemonEnabledResponse>;

  // Speakers
  listSpeakers: () => Promise<ListSpeakersResponse>;
  deleteSpeaker: (req: DeleteSpeakerRequest) => Promise<DeleteSpeakerResponse>;

  // Recent notes
  recentNotes: () => Promise<RecentNotesResponse>;
  openInObsidian: (req: OpenInObsidianRequest) => Promise<OpenInObsidianResponse>;

  // Logs
  getLogBuffer: () => Promise<GetLogBufferResponse>;

  // Launch at login
  getLoginEnabled: () => Promise<GetLoginEnabledResponse>;
  setLoginEnabled: (req: SetLoginEnabledRequest) => Promise<SetLoginEnabledResponse>;

  // Migration
  migrationStatus: () => Promise<MigrationStatusResponse>;
  runMigration: (req: RunMigrationRequest) => Promise<RunMigrationResponse>;
  dismissMigration: () => Promise<DismissMigrationResponse>;

  // Windows
  closeSettings: () => Promise<CloseSettingsResponse>;
  closeLogs: () => Promise<CloseLogsResponse>;

  // Events (main → renderer push)
  onLog: (handler: (ev: RendererLogEvent) => void) => () => void; // returns unsubscribe
  onDaemonState: (handler: (s: DaemonState) => void) => () => void;
  onConfigChanged: (handler: (c: ConfigEditable) => void) => () => void;
  onRecentNotesUpdated: (handler: (notes: RecentNote[]) => void) => () => void;
}

declare global {
  interface Window {
    plaudApi: PlaudApi;
  }
}
