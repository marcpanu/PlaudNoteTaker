import { loadConfig } from "../config.js";
import { loadProfiles, saveProfiles } from "../speakers/profiles.js";

export function runSpeakersList(): void {
  const config = loadConfig();
  const profiles = loadProfiles(config.dataDir);
  const names = Object.keys(profiles);

  if (names.length === 0) {
    console.log("No enrolled speakers.");
    console.log('Label speakers in a note and run "plaude label <file>" to enroll them.');
    return;
  }

  console.log(`Enrolled speakers (${names.length}):`);
  for (const name of names.sort()) {
    console.log(`  - ${name}`);
  }
}

export function runSpeakersDelete(name: string): void {
  const config = loadConfig();
  const profiles = loadProfiles(config.dataDir);

  if (!profiles[name]) {
    console.error(`Speaker "${name}" not found.`);
    const names = Object.keys(profiles);
    if (names.length > 0) {
      console.log(`Enrolled speakers: ${names.sort().join(", ")}`);
    }
    process.exit(1);
  }

  delete profiles[name];
  saveProfiles(config.dataDir, profiles);
  console.log(`Deleted speaker profile: ${name}`);
}
