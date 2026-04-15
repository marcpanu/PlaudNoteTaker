import type { PlaudRecording } from "./plaud/types.js";
import { PlaudClient } from "./plaud/client.js";
import { transcribeAudio } from "./transcription/assemblyai.js";
import { summarizeTranscript } from "./summarization/gemini.js";
import { loadTemplate } from "./notes/template.js";
import { getVaultFolderTree } from "./notes/vault.js";
import {
  buildTranscriptText,
  extractTitle,
  writeNote,
} from "./notes/writer.js";
import { buildSpeakerMap, loadProfiles } from "./speakers/profiles.js";
import { recognizeSpeakers } from "./speakers/eagle.js";
import { convertToWav, decodeToPcm } from "./audio.js";
import { saveRecordingMeta } from "./state.js";
import { log, warn } from "./log.js";
import type { Config } from "./config.js";

export async function processRecording(
  recording: PlaudRecording,
  plaudClient: PlaudClient,
  config: Config,
): Promise<string> {
  const recordingDate = new Date(recording.start_time);
  log(
    `Processing: "${recording.filename}" (${recordingDate.toLocaleDateString()})`,
  );
  log(`  Recording metadata: id=${recording.id} filetype=${recording.filetype} filesize=${recording.filesize} duration=${recording.duration}ms fullname=${recording.fullname}`);

  // 1. Download audio from Plaud
  log("  Downloading audio...");
  const audioBuffer = await plaudClient.downloadRecording(recording.id);
  log(`  Downloaded ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB`);

  // Save raw audio for debugging
  const { writeFileSync, mkdirSync, existsSync } = await import("fs");
  const { join } = await import("path");
  const audioDir = join(config.dataDir, "audio");
  if (!existsSync(audioDir)) mkdirSync(audioDir, { recursive: true });
  const ext = recording.filetype || recording.fullname?.split(".").pop() || "bin";
  const audioPath = join(audioDir, `${recording.id}.${ext}`);
  writeFileSync(audioPath, audioBuffer);
  log(`  Saved audio to: ${audioPath}`);

  // 2. Convert to WAV for reliable transcription (Plaud OGG files fail on AssemblyAI)
  log("  Converting audio to WAV...");
  const wavBuffer = await convertToWav(audioBuffer);
  log(`  Converted: ${(wavBuffer.length / 1024 / 1024).toFixed(1)}MB WAV`);
  const wavPath = join(audioDir, `${recording.id}.wav`);
  writeFileSync(wavPath, wavBuffer);
  log(`  Saved WAV to: ${wavPath}`);

  // 3. Transcribe with AssemblyAI (includes diarization)
  const utterances = await transcribeAudio(
    wavBuffer,
    config.assemblyAiApiKey,
    "wav",
  );
  log(
    `  Transcribed: ${utterances.length} utterances from ${new Set(utterances.map((u) => u.speaker)).size} speakers`,
  );

  if (utterances.length === 0) {
    warn("  No utterances found, skipping note generation");
    return "";
  }

  // 3. Speaker recognition via Picovoice Eagle (if configured)
  let recognizedSpeakers: Map<string, string> | null = null;

  if (config.picovoiceAccessKey) {
    const profiles = loadProfiles(config.dataDir);
    const profileNames = Object.keys(profiles);

    if (profileNames.length > 0) {
      log(`  Running speaker recognition (${profileNames.length} enrolled profiles)...`);
      try {
        const pcm = await decodeToPcm(audioBuffer, 16000);
        const profileBytes = profileNames.map(
          (name) => Uint8Array.from(Buffer.from(profiles[name], "base64")),
        );
        recognizedSpeakers = recognizeSpeakers(
          pcm,
          utterances,
          profileNames,
          profileBytes,
          config.picovoiceAccessKey,
        );
        if (recognizedSpeakers.size > 0) {
          const matches = [...recognizedSpeakers.entries()]
            .map(([label, name]) => `${label}→${name}`)
            .join(", ");
          log(`  Recognized speakers: ${matches}`);
        } else {
          log("  No speakers matched enrolled profiles");
        }
      } catch (error) {
        warn("  Speaker recognition failed, continuing without it:", error);
      }
    }
  }

  // 4. Build speaker map (recognized names or fallback to "Speaker A" labels)
  const speakerLabels = utterances.map((u) => u.speaker);
  const speakerMap = buildSpeakerMap(speakerLabels, recognizedSpeakers);

  const unknownSpeakers = [...speakerMap.entries()]
    .filter(([, name]) => name.startsWith("Speaker "))
    .map(([label]) => label);

  // 5. Build transcript text for LLM
  const transcriptText = buildTranscriptText(utterances, speakerMap);

  // 6. Get vault folder structure for smart routing
  log("  Scanning vault folders...");
  let vaultFolders = "";
  try {
    vaultFolders = getVaultFolderTree(config.vaultPath);
  } catch (error) {
    warn("  Could not scan vault folders:", error);
  }

  // 7. Summarize with Gemini (includes folder selection)
  log("  Generating summary...");
  const template = loadTemplate(
    config.templatesPath,
    config.selectedTemplate,
  );
  const { folder, rawOutput } = await summarizeTranscript(
    transcriptText,
    template,
    vaultFolders,
    config.geminiApiKey,
    config.geminiModel,
  );

  // Use LLM-chosen folder, fall back to config default
  const targetFolder = folder || config.vaultNotesFolder;
  log(`  Target folder: ${targetFolder}`);

  // 8. Build markdown and write to vault
  const filePath = writeNote(
    config.vaultPath,
    targetFolder,
    rawOutput,
    utterances,
    speakerMap,
    unknownSpeakers,
    recordingDate,
  );

  // 9. Save recording metadata for later use by `plaud label`
  saveRecordingMeta(config.dataDir, filePath, {
    recordingId: recording.id,
    utterances: utterances.map((u) => ({
      speaker: u.speaker,
      text: u.text,
      start: u.start,
      end: u.end,
    })),
  });

  log(`  Saved: ${filePath}`);
  return filePath;
}
