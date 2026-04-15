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

export async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string,
): Promise<Utterance[]> {
  console.log("  Uploading audio to AssemblyAI...");
  const uploadUrl = await uploadAudio(audioBuffer, apiKey);

  console.log("  Submitting transcription job...");
  const transcriptId = await submitTranscription(uploadUrl, apiKey);

  console.log("  Waiting for transcription...");
  const result = await pollTranscription(transcriptId, apiKey);

  if (result.status === "error") {
    throw new Error(`Transcription failed: ${result.error}`);
  }

  return result.utterances ?? [];
}

async function uploadAudio(
  audioBuffer: Buffer,
  apiKey: string,
): Promise<string> {
  const response = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/octet-stream",
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
