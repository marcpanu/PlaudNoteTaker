// Empirical test: can @picovoice/eagle-node process a profile enrolled by @picovoice/eagle-web?
//
// Byte analysis strongly suggested "no" (formats differ in size and structure). This test
// feeds the web-SDK profile to the node SDK's Eagle.process() and reports what happens.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Eagle } from "@picovoice/eagle-node";
import { config as loadDotenv } from "dotenv";

loadDotenv();

const accessKey = process.env.PICOVOICE_ACCESS_KEY;
if (!accessKey) {
  console.error("PICOVOICE_ACCESS_KEY not set in .env");
  process.exit(1);
}

// Load the web-SDK profile for "Marc" from the Obsidian plugin's data.json
const pluginDataPath = join(
  homedir(),
  "obsidian-vault/.obsidian/plugins/ai-notetaker/data.json",
);
const plugin = JSON.parse(readFileSync(pluginDataPath, "utf-8"));
const webProfileBase64 = plugin.speakerProfiles?.Marc;
if (!webProfileBase64) {
  console.error("No 'Marc' profile in plugin data.json");
  process.exit(1);
}
function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const buf = Buffer.from(b64, "base64");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const webProfileBytes = b64ToArrayBuffer(webProfileBase64);
console.log(`[test] Loaded web-SDK 'Marc' profile: ${webProfileBytes.byteLength} bytes`);

// Load a node-SDK profile as control (should work)
const cliDataPath = join(
  homedir(),
  "Library/Application Support/Plaud Obsidian Note Taker/data/speaker-profiles.json",
);
const cli = JSON.parse(readFileSync(cliDataPath, "utf-8"));
const nodeProfileBytes = b64ToArrayBuffer(cli["Marc Panu"]);
console.log(`[test] Loaded node-SDK 'Marc Panu' profile: ${nodeProfileBytes.byteLength} bytes`);

// Construct Eagle (a blank PCM chunk is all we need to invoke process())
const eagle = new Eagle(accessKey);
console.log(`[test] Eagle constructed. sampleRate=${eagle.sampleRate}, minProcessSamples=${eagle.minProcessSamples}`);

// Real synthesized speech PCM (16kHz mono s16le, from macOS `say`).
// Needed because Eagle validates profiles lazily during voice frames — silent
// or random-noise PCM won't trigger validation and profile errors wouldn't surface.
const pcmBuf = readFileSync("/tmp/speech.pcm");
const speechPcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
console.log(`[test] Loaded speech PCM: ${speechPcm.length} samples (${(speechPcm.length / 16000).toFixed(1)}s)`);

// Process multiple frames so VAD actually fires somewhere.
const chunkSize = eagle.minProcessSamples;

function feedFrames(profile: ArrayBuffer, label: string): { scores: number[][]; errors: string[] } {
  const scores: number[][] = [];
  const errors: string[] = [];
  for (let off = 0; off + chunkSize <= speechPcm.length; off += chunkSize) {
    const frame = speechPcm.slice(off, off + chunkSize);
    try {
      const s = eagle.process(frame, [profile as any]);
      if (s && s.length > 0) scores.push(Array.from(s));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg.split("\n")[0]);
      break;
    }
  }
  console.log(`[test] ${label}: ${scores.length} frames scored, ${errors.length} errors`);
  if (errors.length) console.log(`       first error: ${errors[0]}`);
  else if (scores.length) {
    const maxScore = Math.max(...scores.map(s => s[0]));
    const avgScore = scores.reduce((a, s) => a + s[0], 0) / scores.length;
    console.log(`       max score: ${maxScore.toFixed(3)}, avg: ${avgScore.toFixed(3)}`);
  }
  return { scores, errors };
}

// Control: node profile — should score without errors
console.log(`\n[test] --- CONTROL: node-SDK profile through node Eagle ---`);
feedFrames(nodeProfileBytes, "Control (node profile)");

// Cross-SDK: web profile through node SDK — the real question
console.log(`\n[test] --- CROSS-SDK: web-SDK profile through node Eagle ---`);
feedFrames(webProfileBytes, "Cross-SDK (web profile)");

// Sanity: garbage bytes — should definitely fail
console.log(`\n[test] --- SANITY: garbage bytes ---`);
const garbage = new ArrayBuffer(1024);
new Uint8Array(garbage).fill(0xab);
feedFrames(garbage, "Garbage (1024 × 0xAB)");

eagle.release();
console.log("[test] done");
