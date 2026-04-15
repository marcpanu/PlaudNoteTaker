import { existsSync } from "fs";
import { resolve, join, basename } from "path";
import { loadConfig } from "../config.js";
import { parseUnknownSpeakers, applyLabels } from "../notes/writer.js";
import { getRecordingMeta } from "../state.js";
import { PlaudClient } from "../plaud/client.js";
import { decodeToPcm } from "../audio.js";
import { enrollSpeaker } from "../speakers/eagle.js";
import { loadProfiles, saveProfiles } from "../speakers/profiles.js";

export async function runLabel(noteArg: string): Promise<void> {
  const config = loadConfig();

  // Resolve note path: could be absolute, relative to cwd, or relative to vault root
  let notePath: string;
  if (existsSync(noteArg)) {
    notePath = resolve(noteArg);
  } else {
    const inVault = join(config.vaultPath, noteArg);
    if (existsSync(inVault)) {
      notePath = resolve(inVault);
    } else {
      console.error(`Note file not found: ${noteArg}`);
      console.error(
        `  Looked in: ${resolve(noteArg)} and ${inVault}`,
      );
      process.exit(1);
    }
  }

  console.log(`Labeling speakers in: ${basename(notePath)}`);

  // Parse the unknown speakers section
  const labels = parseUnknownSpeakers(notePath);
  if (labels.size === 0) {
    console.log("No speaker labels found. Fill in names in the note first:");
    console.log('  > - Speaker A: <name here>');
    process.exit(1);
  }

  console.log("Speaker mappings:");
  for (const [label, name] of labels) {
    console.log(`  Speaker ${label} → ${name}`);
  }

  // Apply text replacements to the note
  applyLabels(notePath, labels);
  console.log("Updated note with speaker names");

  // Enroll speakers if Picovoice is configured
  if (config.picovoiceAccessKey) {
    const meta = getRecordingMeta(config.dataDir, notePath);
    if (!meta) {
      console.warn(
        "No recording metadata found — skipping voice enrollment.",
        "Speaker names are updated but voices won't be recognized in future recordings.",
      );
      return;
    }

    console.log("Enrolling speaker voices for future recognition...");
    const plaudClient = new PlaudClient(config.plaudBearerToken);

    let audioBuffer: Buffer;
    try {
      audioBuffer = await plaudClient.downloadRecording(meta.recordingId);
    } catch (error) {
      console.warn("Failed to download recording for enrollment:", error);
      console.log("Speaker names are updated but voices weren't enrolled.");
      return;
    }

    const pcm = await decodeToPcm(audioBuffer, 16000);
    const profiles = loadProfiles(config.dataDir);

    for (const [label, name] of labels) {
      // Skip if already enrolled
      if (profiles[name]) {
        console.log(`  ${name}: already enrolled, skipping`);
        continue;
      }

      // Get utterance segments for this speaker
      const segments = meta.utterances
        .filter((u) => u.speaker === label)
        .map((u) => ({ startMs: u.start, endMs: u.end }));

      if (segments.length === 0) {
        console.warn(`  ${name}: no utterances found for Speaker ${label}`);
        continue;
      }

      const totalDuration = segments.reduce(
        (sum, s) => sum + (s.endMs - s.startMs),
        0,
      );
      console.log(
        `  ${name}: enrolling from ${segments.length} utterances (${(totalDuration / 1000).toFixed(0)}s of audio)...`,
      );

      try {
        const profile = enrollSpeaker(
          pcm,
          segments,
          config.picovoiceAccessKey,
          16000,
        );
        if (profile) {
          profiles[name] = Buffer.from(profile).toString("base64");
          console.log(`  ${name}: enrolled successfully`);
        } else {
          console.warn(
            `  ${name}: not enough audio for enrollment (need ~10-15s of speech)`,
          );
        }
      } catch (error) {
        console.warn(`  ${name}: enrollment failed:`, error);
      }
    }

    saveProfiles(config.dataDir, profiles);
  } else {
    console.log(
      "Picovoice not configured — speaker names updated but voices not enrolled.",
      "Set PICOVOICE_ACCESS_KEY in .env to enable speaker recognition.",
    );
  }

  console.log("Done!");
}
