import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_FILE = "processed-recordings.json";

interface State {
  processedIds: string[];
}

export function loadProcessedIds(dataDir: string): Set<string> {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

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
