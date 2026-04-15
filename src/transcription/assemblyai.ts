import { log, warn } from "../log.js";

export interface Utterance {
  speaker: string;
  text: string;
  start: number; // milliseconds
  end: number; // milliseconds
}

interface TranscriptResponse {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  error?: string;
  utterances?: Utterance[];
}

const API_BASE = "https://api.assemblyai.com/v2";
const POLL_INTERVAL = 3000;
const MAX_RETRIES = 2;

export async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string,
  fileExtension?: string,
): Promise<Utterance[]> {
  log("  Uploading audio to AssemblyAI...");
  const uploadUrl = await uploadAudio(audioBuffer, apiKey, fileExtension);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log(`  Retrying transcription (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
    }

    log("  Submitting transcription job...");
    const transcriptId = await submitTranscription(uploadUrl, apiKey);

    log(`  Waiting for transcription (id: ${transcriptId})...`);
    const result = await pollTranscription(transcriptId, apiKey);

    if (result.status === "completed") {
      return result.utterances ?? [];
    }

    if (result.status === "error") {
      const isRetryable = result.error?.includes("Internal server error");
      if (isRetryable && attempt < MAX_RETRIES) {
        warn(`  Transcription error (retryable): ${result.error}`);
        continue;
      }
      throw new Error(`Transcription failed: ${result.error}`);
    }
  }

  throw new Error("Transcription failed after retries");
}

const MIME_TYPES: Record<string, string> = {
  ogg: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wma: "audio/x-ms-wma",
};

async function uploadAudio(
  audioBuffer: Buffer,
  apiKey: string,
  fileExtension?: string,
): Promise<string> {
  const contentType = (fileExtension && MIME_TYPES[fileExtension]) || "application/octet-stream";
  log(`  Upload content-type: ${contentType}`);

  const response = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": contentType,
    },
    body: new Uint8Array(audioBuffer),
  });

  if (!response.ok) {
    throw new Error(`AssemblyAI upload failed: ${response.status}`);
  }

  const data = (await response.json()) as { upload_url: string };
  return data.upload_url;
}

async function submitTranscription(
  audioUrl: string,
  apiKey: string,
): Promise<string> {
  const response = await fetch(`${API_BASE}/transcript`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: ["universal-3-pro"],
      speaker_labels: true,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `AssemblyAI transcription submit failed: ${response.status}`,
    );
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

async function pollTranscription(
  transcriptId: string,
  apiKey: string,
): Promise<TranscriptResponse> {
  while (true) {
    const response = await fetch(`${API_BASE}/transcript/${transcriptId}`, {
      headers: { authorization: apiKey },
    });

    if (!response.ok) {
      throw new Error(`AssemblyAI poll failed: ${response.status}`);
    }

    const data = (await response.json()) as TranscriptResponse;

    if (data.status === "completed" || data.status === "error") {
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}
