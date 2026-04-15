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
import { buildSpeakerMap } from "./speakers/profiles.js";
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

  // 3. Build speaker map
  // TODO: Integrate Picovoice Eagle for automatic speaker identification
  // For now, use AssemblyAI's speaker labels (Speaker A, Speaker B, etc.)
  const speakerLabels = utterances.map((u) => u.speaker);
  const speakerMap = buildSpeakerMap(speakerLabels, null);

  // 4. Build transcript text for LLM
  const transcriptText = buildTranscriptText(utterances, speakerMap);

  // 5. Summarize with Gemini
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

  // 6. Build markdown and write to vault
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
