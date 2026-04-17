import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

export interface SpeakerProfiles {
  [name: string]: string; // name → base64-encoded Eagle profile
}

const PROFILES_FILE = "speaker-profiles.json";

export function loadProfiles(dataDir: string): SpeakerProfiles {
  const path = join(dataDir, PROFILES_FILE);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Atomic write: serialize to a sibling `.tmp` file then rename over the target.
 * Prevents torn writes if the daemon and a concurrent plugin-triggered enrollment
 * (via HTTP bridge) happen to save at nearly the same time — the worst case is
 * last-writer-wins, never a truncated JSON file.
 */
export function saveProfiles(
  dataDir: string,
  profiles: SpeakerProfiles,
): void {
  const path = join(dataDir, PROFILES_FILE);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(profiles, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    // If the temp file got created but the rename failed, clean up so we don't
    // leave stale `.tmp` files around.
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
    throw err;
  }
}

export function buildSpeakerMap(
  utteranceSpeakers: string[],
  recognizedSpeakers: Map<string, string> | null,
): Map<string, string> {
  const map = new Map<string, string>();
  const uniqueSpeakers = [...new Set(utteranceSpeakers)];

  for (const speaker of uniqueSpeakers) {
    if (recognizedSpeakers?.has(speaker)) {
      map.set(speaker, recognizedSpeakers.get(speaker)!);
    } else {
      map.set(speaker, `Speaker ${speaker}`);
    }
  }

  return map;
}
