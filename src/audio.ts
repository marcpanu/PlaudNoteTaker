import { execFile } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

/**
 * Decode audio buffer (any format ffmpeg supports) to raw PCM Int16 mono
 * at the specified sample rate. Requires ffmpeg installed.
 */
export function decodeToPcm(
  audioBuffer: Buffer,
  sampleRate: number,
): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    // Write input to temp file (ffmpeg needs seekable input for some formats)
    const tmpInput = join(tmpdir(), `plaude-${randomUUID()}.audio`);
    const tmpOutput = join(tmpdir(), `plaude-${randomUUID()}.raw`);

    writeFileSync(tmpInput, audioBuffer);

    execFile(
      "ffmpeg",
      [
        "-i", tmpInput,
        "-f", "s16le",        // raw signed 16-bit little-endian
        "-acodec", "pcm_s16le",
        "-ac", "1",           // mono
        "-ar", String(sampleRate),
        "-y",                 // overwrite
        tmpOutput,
      ],
      { maxBuffer: 500 * 1024 * 1024 }, // 500MB for large recordings
      (error, _stdout, stderr) => {
        // Clean up input file
        try { unlinkSync(tmpInput); } catch { /* ignore */ }

        if (error) {
          try { unlinkSync(tmpOutput); } catch { /* ignore */ }
          reject(new Error(`ffmpeg decode failed: ${stderr}`));
          return;
        }

        try {
          const rawBuffer = readFileSync(tmpOutput);
          unlinkSync(tmpOutput);

          // Convert Buffer to Int16Array
          const int16 = new Int16Array(
            rawBuffer.buffer,
            rawBuffer.byteOffset,
            rawBuffer.byteLength / 2,
          );
          resolve(int16);
        } catch (err) {
          reject(err);
        }
      },
    );
  });
}
