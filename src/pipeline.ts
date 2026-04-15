import type { PlaudRecording } from "./plaud/types.js";
import { PlaudClient } from "./plaud/client.js";
import { transcribeAudio } from "./transcription/assemblyai.js";
import { summarizeTranscript } from "./summarization/gemini.js";
import { loadTemplate } from "./notes/template.js";
import {
  buildTranscriptText,
  buildMarkdown,
  extractTitle,
  writeNote,
} from "./notes/writer.js";
import { buildSpeakerMap, loadProfiles } from "./speakers/profiles.js";
import { recognizeSpeakers } from "./speakers/eagle.js";
import { decodeToPcm } from "./audio.js";
import { config } from "./config.js";

export async function processRecording(
  recording: PlaudRecording,
  plaudClient: PlaudClient,
): Promise<string> {
  const recordingDate = new Date(recording.start_time);
  console.log(
    `Processing: "${recording.filename}" (${recordingDate.toLocaleDateString()})`,
  );

  // 1. Download audio from Plaud
  console.log("  Downloading audio...");
  const audioBuffer = await plaudClient.downloadRecording(recording.id);
  console.log(`  Downloaded ${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB`);

  // 2. Transcribe with AssemblyAI (includes diarization)
  const utterances = await transcribeAudio(
    audioBuffer,
    config.assemblyAiApiKey,
  );
  console.log(
    `  Transcribed: ${utterances.length} utterances from ${new Set(utterances.map((u) => u.speaker)).size} speakers`,
  );

  if (utterances.length === 0) {
    console.warn("  No utterances found, skipping note generation");
    return "";
  }

  // 3. Speaker recognition via Picovoice Eagle (if configured)
  let recognizedSpeakers: Map<string, string> | null = null;

  if (config.picovoiceAccessKey) {
    const profiles = loadProfiles(config.dataDir);
    const profileNames = Object.keys(profiles);

    if (profileNames.length > 0) {
      console.log(`  Running speaker recognition (${profileNames.length} enrolled profiles)...`);
      try {
        // Decode audio to PCM for Eagle (Eagle needs raw PCM, not compressed)
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
          console.log(`  Recognized speakers: ${matches}`);
        } else {
          console.log("  No speakers matched enrolled profiles");
        }
      } catch (error) {
        console.warn("  Speaker recognition failed, continuing without it:", error);
      }
    }
  }

  // 4. Build speaker map (recognized names or fallback to "Speaker A" labels)
  const speakerLabels = utterances.map((u) => u.speaker);
  const speakerMap = buildSpeakerMap(speakerLabels, recognizedSpeakers);

  // 5. Build transcript text for LLM
  const transcriptText = buildTranscriptText(utterances, speakerMap);

  // 6. Summarize with Gemini
  console.log("  Generating summary...");
  const template = loadTemplate(
    config.templatesPath,
    config.selectedTemplate,
  );
  const geminiOutput = await summarizeTranscript(
    transcriptText,
    template,
    config.geminiApiKey,
    config.geminiModel,
  );

  // 7. Build markdown and write to vault
  const markdown = buildMarkdown(
    geminiOutput,
    utterances,
    speakerMap,
    recordingDate,
  );
  const title = extractTitle(geminiOutput);
  const filePath = writeNote(
    config.vaultPath,
    config.vaultNotesFolder,
    markdown,
    title,
    recordingDate,
  );

  console.log(`  Saved: ${filePath}`);
  return filePath;
}
