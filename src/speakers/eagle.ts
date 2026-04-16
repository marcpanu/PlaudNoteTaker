import { Eagle, EagleProfiler } from "@picovoice/eagle-node";
import type { Utterance } from "../transcription/assemblyai.js";

const SCORE_THRESHOLD = 0.3;

interface SpeakerScore {
  totalScore: number;
  count: number;
}

/**
 * Convert a base64-encoded profile to an ArrayBuffer that Eagle accepts.
 * Eagle's native code requires ArrayBuffer, not Uint8Array.
 */
export function profileFromBase64(b64: string): ArrayBuffer {
  const buf = Buffer.from(b64, "base64");
  // Buffer uses a shared pool — .buffer may be 8KB. Slice to get a clean ArrayBuffer.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Convert an ArrayBuffer profile to base64 for storage.
 */
export function profileToBase64(profile: ArrayBuffer): string {
  return Buffer.from(profile).toString("base64");
}

/**
 * Run Eagle speaker recognition on pre-recorded audio against enrolled profiles.
 * Returns a map of AssemblyAI speaker label → enrolled speaker name.
 */
export function recognizeSpeakers(
  pcm: Int16Array,
  utterances: Utterance[],
  profileNames: string[],
  profileBuffers: ArrayBuffer[],
  accessKey: string,
): Map<string, string> {
  if (profileNames.length === 0 || profileBuffers.length === 0) {
    return new Map();
  }

  const eagle = new Eagle(accessKey);
  const sampleRate = eagle.sampleRate;
  const chunkSize = eagle.minProcessSamples;

  try {
    const speakerScores = new Map<string, SpeakerScore[]>();

    for (let offset = 0; offset + chunkSize <= pcm.length; offset += chunkSize) {
      const frame = pcm.slice(offset, offset + chunkSize);
      // Eagle requires ArrayBuffer[], not Uint8Array[]
      const scores = eagle.process(frame, profileBuffers as any);

      if (!scores || scores.length === 0) continue;

      const frameTimeMs = (offset / sampleRate) * 1000;
      const utterance = utterances.find(
        (u) => frameTimeMs >= u.start && frameTimeMs <= u.end,
      );
      if (!utterance) continue;

      if (!speakerScores.has(utterance.speaker)) {
        speakerScores.set(
          utterance.speaker,
          profileNames.map(() => ({ totalScore: 0, count: 0 })),
        );
      }

      const labelScores = speakerScores.get(utterance.speaker)!;
      for (let i = 0; i < scores.length; i++) {
        labelScores[i].totalScore += scores[i];
        labelScores[i].count += 1;
      }
    }

    return assignSpeakers(speakerScores, profileNames);
  } finally {
    eagle.release();
  }
}

function assignSpeakers(
  speakerScores: Map<string, SpeakerScore[]>,
  profileNames: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  const usedProfiles = new Set<number>();

  const candidates: [string, number, number][] = [];
  for (const [label, scores] of speakerScores) {
    for (let i = 0; i < scores.length; i++) {
      if (scores[i].count === 0) continue;
      const avg = scores[i].totalScore / scores[i].count;
      if (avg >= SCORE_THRESHOLD) {
        candidates.push([label, i, avg]);
      }
    }
  }

  candidates.sort((a, b) => b[2] - a[2]);

  for (const [label, profileIndex] of candidates) {
    if (result.has(label) || usedProfiles.has(profileIndex)) continue;
    result.set(label, profileNames[profileIndex]);
    usedProfiles.add(profileIndex);
  }

  return result;
}

/**
 * Enroll a speaker from audio segments.
 * Returns the profile as an ArrayBuffer, or null if enrollment didn't reach 100%.
 */
export function enrollSpeaker(
  pcm: Int16Array,
  segments: { startMs: number; endMs: number }[],
  accessKey: string,
  sampleRate: number,
): ArrayBuffer | null {
  const profiler = new EagleProfiler(accessKey);

  try {
    const frameLength = profiler.frameLength;
    let percentage = 0;

    for (const segment of segments) {
      const startSample = Math.floor((segment.startMs / 1000) * sampleRate);
      const endSample = Math.ceil((segment.endMs / 1000) * sampleRate);
      const segmentPcm = pcm.slice(startSample, endSample);

      for (
        let offset = 0;
        offset + frameLength <= segmentPcm.length;
        offset += frameLength
      ) {
        const frame = segmentPcm.slice(offset, offset + frameLength);
        percentage = profiler.enroll(frame);

        if (percentage >= 100) {
          // export() returns ArrayBuffer backed by native memory.
          // Must copy before profiler.release() frees it.
          const exported = profiler.export() as unknown as ArrayBuffer;
          const copy = exported.slice(0);
          return copy;
        }
      }
    }

    if (percentage > 0 && percentage < 100) {
      console.warn(
        `Enrollment only reached ${percentage.toFixed(0)}%, may not be reliable`,
      );
    }

    return null;
  } finally {
    profiler.release();
  }
}
