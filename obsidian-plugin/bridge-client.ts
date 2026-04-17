/**
 * bridge-client.ts
 *
 * Typed HTTP wrapper for the PlaudNoteTaker daemon's loopback bridge.
 * Uses Obsidian's requestUrl (NOT fetch — CORS blocks fetch to 127.0.0.1
 * from Obsidian's app:// origin).
 *
 * Reads bridge.json from the daemon's userData directory to get the
 * ephemeral port and bearer token written by the daemon on startup.
 */

import { requestUrl } from "obsidian";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BRIDGE_JSON = join(
	homedir(),
	"Library/Application Support/Plaud Obsidian Note Taker/bridge.json",
);

export interface ApiKeys {
	plaud: string;
	assemblyai: string;
	gemini: string;
	picovoice: string;
}

export interface Utterance {
	speaker: string;
	start: number;
	end: number;
	text: string;
}

export interface BridgeClient {
	isDaemonAvailable(): Promise<boolean>;
	getApiKeys(): Promise<ApiKeys | null>;
	listSpeakers(): Promise<string[]>;
	deleteSpeaker(name: string): Promise<boolean>;
	enrollSpeaker(
		name: string,
		pcm: Int16Array,
	): Promise<{ ok: boolean; error?: string; feedback?: number }>;
	recognizeSpeakers(
		pcm: Int16Array,
		utterances: Utterance[],
	): Promise<Record<string, string>>;
	labelSpeakers(
		notePath: string,
	): Promise<{ ok: boolean; matched: number; enrolled: number; error?: string }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readBridge(): { port: number; token: string } | null {
	if (!existsSync(BRIDGE_JSON)) return null;
	try {
		const { port, token } = JSON.parse(readFileSync(BRIDGE_JSON, "utf-8"));
		if (typeof port !== "number" || typeof token !== "string") return null;
		return { port, token };
	} catch {
		return null;
	}
}

function int16ToBase64(pcm: Int16Array): string {
	// In Electron's renderer we have access to Buffer (Node.js global)
	const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	return buf.toString("base64");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBridgeClient(): BridgeClient {
	async function request(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<any> {
		const bridge = readBridge();
		if (!bridge) throw new Error("Daemon not running (bridge.json not found)");
		const url = `http://127.0.0.1:${bridge.port}${path}`;
		const res = await requestUrl({
			url,
			method,
			headers: {
				Authorization: `Bearer ${bridge.token}`,
				"Content-Type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (res.status >= 400) {
			const msg = res.json?.error ?? `HTTP ${res.status}`;
			throw new Error(msg);
		}
		return res.json;
	}

	return {
		async isDaemonAvailable() {
			try {
				const r = await request("GET", "/health");
				return r.ok === true;
			} catch {
				return false;
			}
		},

		async getApiKeys() {
			try {
				const r = await request("GET", "/config/api-keys");
				return r.keys as ApiKeys;
			} catch {
				return null;
			}
		},

		async listSpeakers() {
			const r = await request("GET", "/speakers");
			return r.speakers as string[];
		},

		async deleteSpeaker(name: string) {
			const r = await request("DELETE", `/speakers/${encodeURIComponent(name)}`);
			return r.removed === true;
		},

		async enrollSpeaker(name: string, pcm: Int16Array) {
			return await request("POST", "/speakers/enroll", {
				name,
				pcm_base64: int16ToBase64(pcm),
			});
		},

		async recognizeSpeakers(pcm: Int16Array, utterances: Utterance[]) {
			const r = await request("POST", "/speakers/recognize", {
				pcm_base64: int16ToBase64(pcm),
				utterances,
			});
			return r.matches as Record<string, string>;
		},

		async labelSpeakers(notePath: string) {
			return await request("POST", "/label-speakers", { notePath });
		},
	};
}

/**
 * Concatenate a target speaker's utterance audio from a recording's full PCM,
 * capped at `maxSeconds` total. Matches the quota-conserving behavior the CLI
 * uses during Plaud recording enrollment (see src/speakers/eagle.ts MAX_SECONDS_PER_SPEAKER).
 *
 * Why client-side: Picovoice Eagle's enrollment quota is the scarce resource,
 * and it only processes whatever audio we give it. Pre-slicing here means the
 * HTTP payload to /speakers/enroll is ~30s not the full recording, AND we
 * guarantee the daemon only sees this speaker's audio (not any other
 * speaker's utterances in the recording, which would corrupt the profile).
 *
 * Assumes 16kHz mono Int16 PCM (what the plugin records at).
 */
export function sliceSpeakerPcm(
	fullPcm: Int16Array,
	utterances: Utterance[],
	targetSpeaker: string,
	maxSeconds = 30,
): Int16Array {
	const sampleRate = 16000;
	const maxSamples = Math.floor(maxSeconds * sampleRate);
	const targetUtts = utterances.filter((u) => u.speaker === targetSpeaker);

	const slices: Int16Array[] = [];
	let totalSamples = 0;

	for (const utt of targetUtts) {
		const startSample = Math.max(0, Math.floor((utt.start / 1000) * sampleRate));
		const endSample = Math.min(
			fullPcm.length,
			Math.ceil((utt.end / 1000) * sampleRate),
		);
		if (endSample <= startSample) continue;

		const remaining = maxSamples - totalSamples;
		if (remaining <= 0) break;

		const take = Math.min(endSample - startSample, remaining);
		const slice = fullPcm.slice(startSample, startSample + take);
		slices.push(slice);
		totalSamples += slice.length;
	}

	const result = new Int16Array(totalSamples);
	let offset = 0;
	for (const slice of slices) {
		result.set(slice, offset);
		offset += slice.length;
	}
	return result;
}
