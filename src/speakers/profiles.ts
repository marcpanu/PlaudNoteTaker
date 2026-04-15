import { readFileSync, writeFileSync, existsSync } from "fs";
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

export function saveProfiles(
  dataDir: string,
  profiles: SpeakerProfiles,
): void {
  const path = join(dataDir, PROFILES_FILE);
  writeFileSync(path, JSON.stringify(profiles, null, 2));
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
