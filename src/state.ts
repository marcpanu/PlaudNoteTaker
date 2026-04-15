import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_FILE = "processed-recordings.json";
const META_FILE = "recording-meta.json";

interface State {
  processedIds: string[];
}

export interface RecordingMeta {
  recordingId: string;
  utterances: {
    speaker: string;
    text: string;
    start: number;
    end: number;
  }[];
}

// --- Processed IDs ---

export function loadProcessedIds(dataDir: string): Set<string> {
  ensureDataDir(dataDir);
  const path = join(dataDir, STATE_FILE);
  if (!existsSync(path)) return new Set();
  const state = JSON.parse(readFileSync(path, "utf-8")) as State;
  return new Set(state.processedIds);
}

export function saveProcessedId(dataDir: string, id: string): void {
  const existing = loadProcessedIds(dataDir);
  existing.add(id);
  const path = join(dataDir, STATE_FILE);
  const state: State = { processedIds: [...existing] };
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// --- Recording Metadata (for `plaud label`) ---

type MetaStore = Record<string, RecordingMeta>; // keyed by note filename

function loadMetaStore(dataDir: string): MetaStore {
  ensureDataDir(dataDir);
  const path = join(dataDir, META_FILE);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as MetaStore;
}

function saveMetaStore(dataDir: string, store: MetaStore): void {
  const path = join(dataDir, META_FILE);
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export function saveRecordingMeta(
  dataDir: string,
  noteFilePath: string,
  meta: RecordingMeta,
): void {
  const store = loadMetaStore(dataDir);
  store[noteFilePath] = meta;
  saveMetaStore(dataDir, store);
}

export function getRecordingMeta(
  dataDir: string,
  noteFilePath: string,
): RecordingMeta | null {
  const store = loadMetaStore(dataDir);
  return store[noteFilePath] ?? null;
}

function ensureDataDir(dataDir: string): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}
