import {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	Editor,
	Modal,
	requestUrl,
	MarkdownView,
	ItemView,
	WorkspaceLeaf,
	setIcon,
	TFolder,
	TFile,
	FileSystemAdapter,
} from "obsidian";
import { createBridgeClient, BridgeClient, sliceSpeakerPcm } from "./bridge-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AINotetakerSettings {
	assemblyAiApiKey: string;
	picovoiceAccessKey: string;
	geminiApiKey: string;
	templateFolder: string;
	selectedTemplate: string;
	geminiModel: string;
	enableStreaming: boolean;
}

const DEFAULT_SETTINGS: AINotetakerSettings = {
	assemblyAiApiKey: "",
	picovoiceAccessKey: "",
	geminiApiKey: "",
	templateFolder: "AI Notetaker Templates",
	selectedTemplate: "Default",
	geminiModel: "gemini-2.5-flash",
	enableStreaming: false,
};

const DEFAULT_TEMPLATE = `You are a meeting notes assistant. Given the following meeting transcript with speaker labels, produce structured meeting notes in markdown format.

## Output format:

Your response MUST begin with a single-line title for the meeting on the first line, prefixed with "# " (markdown H1). The title should be a concise, descriptive summary of the meeting topic (e.g., "# Q2 Marketing Strategy Review"). Do NOT include a date in the title.

### Attendees
List each speaker with their name. If their role or organization is mentioned in the conversation, include it.

### Summary
Provide a clear overall summary of the meeting. Use a mix of prose and bullet points as appropriate to capture key discussion points, decisions made, and important context.

### Action Items
List action items as a task list. Tag each with the owner.
- [ ] **Owner:** Description of the action item

## Transcript:
{{transcript}}`;

interface AssemblyAIUtterance {
	speaker: string;
	text: string;
	start: number;
	end: number;
}

interface AssemblyAITranscriptResponse {
	id: string;
	status: "queued" | "processing" | "completed" | "error";
	error?: string;
	utterances?: AssemblyAIUtterance[];
}

const SPEAKER_VIEW_TYPE = "ai-notetaker-speakers";

/**
 * Marker for the end of the in-progress live transcript block in the editor.
 * The block's START is identified by its visible header `\n\n---\n*Live transcript:*\n`
 * (unique enough on its own — no hidden start sentinel needed). This END marker
 * is an invisible HTML comment. All block operations locate it via
 * content.indexOf() so they remain correct regardless of user edits elsewhere
 * in the note during recording.
 */
const LIVE_END_SENTINEL = "<!-- live-transcript-end -->";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class AINotetakerPlugin extends Plugin {
	settings: AINotetakerSettings = DEFAULT_SETTINGS;
	private statusBarItem: HTMLElement | null = null;
	private ribbonIconEl: HTMLElement | null = null;
	private mediaRecorder: MediaRecorder | null = null;
	private audioChunks: Blob[] = [];
	isRecording = false;

	// Bridge client for all Eagle / API-key operations
	bridgeClient!: BridgeClient;

	// PCM recording state (sent to bridge after recording for recognition/enrollment)
	private pcmBuffer: Int16Array = new Int16Array(0);
	private fullPcmRecording: Int16Array = new Int16Array(0);
	private recordingStartTime = 0;

	// Streaming transcription state
	private streamingSocket: WebSocket | null = null;
	private streamingEditor: Editor | null = null;
	private streamingInsertPos: { line: number; ch: number } | null = null;
	private streamingText = "";
	private streamingAudioContext: AudioContext | null = null;
	private streamingWorkletNode: AudioWorkletNode | null = null;
	private streamingSource: MediaStreamAudioSourceNode | null = null;

	// Last recording data for deferred labeling via "Label Speakers"
	private lastUtterances: AssemblyAIUtterance[] | null = null;
	private lastFullPcm: Int16Array | null = null;

	// Cache of enrolled speaker names (refreshed from bridge)
	enrolledSpeakerNames: string[] = [];

	// Remembered reference to the most recently focused MarkdownView's editor.
	// Needed because clicking anything inside the Speaker Panel sidebar shifts
	// focus to a non-markdown view, which makes getActiveViewOfType(MarkdownView)
	// return null at the moment a sidebar button handler runs. Without this
	// fallback, recording triggered from the sidebar lands its streaming and
	// final transcript in whatever markdown leaf iterateAllLeaves happens to
	// find first — usually not the one the user was actually looking at.
	private lastActiveMarkdownEditor: Editor | null = null;

	// PCM capture internals
	private pcmAudioContext: AudioContext | null = null;
	private pcmWorkletNode: AudioWorkletNode | null = null;
	private pcmSource: MediaStreamAudioSourceNode | null = null;

	async onload() {
		await this.loadSettings();

		this.bridgeClient = createBridgeClient();
		await this.refreshApiKeys(); // try bridge, fall back to settings cache

		// Refresh enrolled speaker names from bridge (non-blocking)
		this.refreshEnrolledSpeakers().catch(() => {});

		this.statusBarItem = this.addStatusBarItem();

		this.addCommand({
			id: "start-stop-recording",
			name: "Start / Stop Recording",
			icon: "mic",
			editorCallback: (editor: Editor) => {
				if (this.isRecording) {
					this.stopRecording(editor);
				} else {
					this.startRecording();
				}
			},
		});

		this.addCommand({
			id: "label-speakers",
			name: "Label Speakers",
			icon: "users",
			editorCallback: (editor: Editor) => {
				this.labelSpeakersInNote(editor);
			},
		});

		this.addCommand({
			id: "enroll-speaker",
			name: "Enroll Speaker Voice Profile",
			callback: () => {
				new EnrollSpeakerModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "manage-speakers",
			name: "Manage Speaker Profiles",
			callback: () => {
				new ManageSpeakersModal(this.app, this).open();
			},
		});

		this.addSettingTab(new AINotetakerSettingTab(this.app, this));

		// Track the most recently focused MarkdownView's editor. Used by
		// getMarkdownEditor() as a fallback so sidebar-triggered recording
		// knows which note the user was actually looking at before they
		// clicked into the sidebar (which shifts focus away from the note).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof MarkdownView) {
					this.lastActiveMarkdownEditor = leaf.view.editor;
				}
			}),
		);
		// Initial capture — if a markdown view is already active when the
		// plugin loads, remember its editor so first-run recording works too.
		const initialView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (initialView) {
			this.lastActiveMarkdownEditor = initialView.editor;
		}

		// Ribbon icon — toggles recording
		this.ribbonIconEl = this.addRibbonIcon("mic", "AI Notetaker: Record", () => {
			const editor = this.getMarkdownEditor();
			if (!editor) {
				new Notice("AI Notetaker: Open a note first.");
				return;
			}
			if (this.isRecording) {
				this.stopRecording(editor);
			} else {
				this.startRecording();
			}
		});

		// Sidebar view for speaker management
		this.registerView(SPEAKER_VIEW_TYPE, (leaf) => new SpeakerPanelView(leaf, this));

		this.addCommand({
			id: "open-speaker-panel",
			name: "Open Speaker Panel",
			callback: () => this.activateSpeakerPanel(),
		});

	}

	onunload() {
		if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
			this.mediaRecorder.stop();
		}
		this.stopAudioCapture();
		this.stopStreamingTranscription();
		this.setStatusBar("");
		this.app.workspace.detachLeavesOfType(SPEAKER_VIEW_TYPE);
	}

	async activateSpeakerPanel() {
		const existing = this.app.workspace.getLeavesOfType(SPEAKER_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SPEAKER_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}

	// -- Settings helpers ----------------------------------------------------

	async loadSettings() {
		const loaded = await this.loadData();
		// Strip speakerProfiles from legacy settings (profiles now live in daemon)
		const { speakerProfiles: _dropped, ...rest } = (loaded ?? {}) as any;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// -- Bridge helpers -------------------------------------------------------

	/** Fetch API keys from daemon and cache in plugin settings as fallback. */
	async refreshApiKeys() {
		try {
			const keys = await this.bridgeClient.getApiKeys();
			if (keys) {
				this.settings.assemblyAiApiKey = keys.assemblyai;
				this.settings.geminiApiKey = keys.gemini;
				this.settings.picovoiceAccessKey = keys.picovoice;
				await this.saveSettings();
				console.log("[ai-notetaker] API keys refreshed from daemon");
			} else {
				console.log("[ai-notetaker] daemon unavailable, using cached plugin-settings keys");
			}
		} catch {
			console.log("[ai-notetaker] daemon unavailable, using cached plugin-settings keys");
		}
	}

	/** Refresh enrolled speaker names from bridge (updates UI caches). */
	async refreshEnrolledSpeakers() {
		try {
			this.enrolledSpeakerNames = await this.bridgeClient.listSpeakers();
		} catch {
			// daemon may not be running; keep whatever we had
		}
	}

	/** Get current enrolled speaker names (cached). */
	getEnrolledSpeakerNames(): string[] {
		return this.enrolledSpeakerNames;
	}

	// -- UI helpers ----------------------------------------------------------

	/** Find the most recent MarkdownView editor, even if a sidebar panel is focused. */
	getMarkdownEditor(): Editor | null {
		// Preferred: active markdown view (user is currently focused there).
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active.editor;
		// Fallback 1: last-active markdown editor we remembered via the
		// active-leaf-change event listener. Covers the sidebar-button case —
		// clicking inside the Speaker Panel shifts active view off the
		// markdown editor, but we kept the editor reference from before.
		if (this.lastActiveMarkdownEditor) return this.lastActiveMarkdownEditor;
		// Fallback 2 (legacy): iterate all leaves. Used only if the plugin
		// was loaded and no markdown view has ever been active.
		let mdEditor: Editor | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!mdEditor && leaf.view.getViewType() === "markdown") {
				const view = leaf.view as MarkdownView;
				if (view.editor && (view as any).file) {
					mdEditor = view.editor;
				}
			}
		});
		return mdEditor;
	}

	private updateRibbonIcon() {
		if (!this.ribbonIconEl) return;
		if (this.isRecording) {
			setIcon(this.ribbonIconEl, "square");
			this.ribbonIconEl.setAttribute("aria-label", "AI Notetaker: Stop Recording");
			this.ribbonIconEl.addClass("ai-notetaker-recording");
		} else {
			setIcon(this.ribbonIconEl, "mic");
			this.ribbonIconEl.setAttribute("aria-label", "AI Notetaker: Record");
			this.ribbonIconEl.removeClass("ai-notetaker-recording");
		}
	}

	refreshSpeakerPanel() {
		for (const leaf of this.app.workspace.getLeavesOfType(SPEAKER_VIEW_TYPE)) {
			(leaf.view as SpeakerPanelView).refresh();
		}
	}

	private setStatusBar(text: string) {
		if (this.statusBarItem) {
			this.statusBarItem.setText(text);
		}
	}

	// -- Recording -----------------------------------------------------------

	async startRecording() {
		if (!this.settings.assemblyAiApiKey) {
			new Notice("AI Notetaker: Please set your AssemblyAI API key in settings.");
			return;
		}

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			new Notice("AI Notetaker: Microphone access denied.");
			return;
		}

		this.audioChunks = [];

		const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
			? "audio/webm;codecs=opus"
			: "";

		this.mediaRecorder = mimeType
			? new MediaRecorder(stream, { mimeType })
			: new MediaRecorder(stream);

		this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
			if (event.data.size > 0) {
				this.audioChunks.push(event.data);
			}
		};

		this.mediaRecorder.start(1000);
		this.isRecording = true;
		this.recordingStartTime = Date.now();
		this.setStatusBar("🔴 Recording…");
		this.updateRibbonIcon();
		this.refreshSpeakerPanel();
		new Notice("AI Notetaker: Recording started.");

		// Clear previous recording data
		this.lastUtterances = null;
		this.lastFullPcm = null;

		// Start PCM capture for speaker recognition (sent to bridge after recording)
		await this.startAudioCapture(stream);

		// Start streaming transcription if enabled
		if (this.settings.enableStreaming) {
			const editor = this.getMarkdownEditor();
			if (editor) {
				await this.startStreamingTranscription(stream, editor);
			}
		}
	}

	// -- PCM capture (for bridge-based recognition) --------------------------

	private async startAudioCapture(stream: MediaStream) {
		const EAGLE_SAMPLE_RATE = 16000;

		try {
			this.fullPcmRecording = new Int16Array(0);
			this.pcmBuffer = new Int16Array(0);

			this.pcmAudioContext = new AudioContext();
			const nativeSampleRate = this.pcmAudioContext.sampleRate;

			const workletCode = `
class PCMCaptureProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new Float32Array(4096);
		this.writeIndex = 0;
	}
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		for (let i = 0; i < channel.length; i++) {
			this.buffer[this.writeIndex++] = channel[i];
			if (this.writeIndex >= this.buffer.length) {
				this.port.postMessage(this.buffer.slice());
				this.writeIndex = 0;
			}
		}
		return true;
	}
}
registerProcessor('pcm-capture-processor-bridge', PCMCaptureProcessor);
`;
			const blob = new Blob([workletCode], { type: "application/javascript" });
			const url = URL.createObjectURL(blob);
			await this.pcmAudioContext.audioWorklet.addModule(url);
			URL.revokeObjectURL(url);

			this.pcmSource = this.pcmAudioContext.createMediaStreamSource(stream);
			this.pcmWorkletNode = new AudioWorkletNode(this.pcmAudioContext, "pcm-capture-processor-bridge");

			this.pcmWorkletNode.port.onmessage = (e: MessageEvent) => {
				const float32Chunk = e.data as Float32Array;
				// Downsample to Eagle sample rate
				const resampled = downsamplePcm(float32Chunk, nativeSampleRate, EAGLE_SAMPLE_RATE);
				const int16 = float32ToInt16(resampled);

				// Append to full recording buffer
				const newFull = new Int16Array(this.fullPcmRecording.length + int16.length);
				newFull.set(this.fullPcmRecording);
				newFull.set(int16, this.fullPcmRecording.length);
				this.fullPcmRecording = newFull;
			};

			this.pcmSource.connect(this.pcmWorkletNode);
		} catch (err) {
			console.error("AI Notetaker: Failed to start PCM capture:", err);
			// Recording continues without PCM capture — speaker recognition won't work
		}
	}

	private stopAudioCapture() {
		if (this.pcmWorkletNode) {
			this.pcmWorkletNode.disconnect();
			this.pcmWorkletNode = null;
		}
		if (this.pcmSource) {
			this.pcmSource.disconnect();
			this.pcmSource = null;
		}
		if (this.pcmAudioContext) {
			this.pcmAudioContext.close().catch(() => {});
			this.pcmAudioContext = null;
		}
		this.pcmBuffer = new Int16Array(0);
	}

	// -- Live transcript block helpers (content-search, edit-robust) ---------

	/** Insert text immediately before the live-end sentinel. No-op if the sentinel is missing. */
	private appendLive(editor: Editor, text: string): void {
		const content = editor.getValue();
		const endIdx = content.indexOf(LIVE_END_SENTINEL);
		if (endIdx < 0) return;
		const pos = editor.offsetToPos(endIdx);
		editor.replaceRange(text, pos);
	}

	/**
	 * Replace the last `partialLen` chars before the live-end sentinel with `newText`.
	 * Used by the streaming turn handler to update the in-flight partial in place.
	 */
	private replaceLivePartial(editor: Editor, partialLen: number, newText: string): void {
		const content = editor.getValue();
		const endIdx = content.indexOf(LIVE_END_SENTINEL);
		if (endIdx < 0) return;
		const from = editor.offsetToPos(endIdx - partialLen);
		const to = editor.offsetToPos(endIdx);
		editor.replaceRange(newText, from, to);
	}

	/**
	 * Locate the full live-transcript block (the header line through the end
	 * sentinel's trailing newline) and replace it with `finalText` in one edit.
	 * Called when the final cleaned transcript is ready, so the user sees the
	 * live block stay in place during "transcribing / generating…" and swap
	 * atomically when the final note is inserted.
	 *
	 * Returns true if the block was found and replaced; false if no streaming
	 * block was ever inserted (non-streaming path) — caller should fall back
	 * to inserting at the cursor.
	 */
	private replaceLiveTranscriptBlock(editor: Editor, finalText: string): boolean {
		const content = editor.getValue();
		// Block starts at the visible `\n\n---\n*Live transcript:*\n` header.
		// Ends at the invisible sentinel. Both are searched via indexOf()
		// against current content so user edits elsewhere don't break them.
		const HEADER = "\n\n---\n*Live transcript:*\n";
		const headerIdx = content.indexOf(HEADER);
		const endIdx = content.indexOf(LIVE_END_SENTINEL);
		if (headerIdx < 0 || endIdx < 0 || endIdx < headerIdx) return false;

		// Include the sentinel itself and its trailing newline (if any).
		let blockEnd = endIdx + LIVE_END_SENTINEL.length;
		if (content[blockEnd] === "\n") blockEnd += 1;

		const from = editor.offsetToPos(headerIdx);
		const to = editor.offsetToPos(blockEnd);
		editor.replaceRange(finalText, from, to);
		return true;
	}

	// -- Streaming transcription ---------------------------------------------

	private async startStreamingTranscription(stream: MediaStream, editor: Editor) {
		const apiKey = this.settings.assemblyAiApiKey;

		try {
			// Connect directly with API key as token (v3 API supports this)
			const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-streaming-english&token=${apiKey}`;
			this.streamingSocket = new WebSocket(wsUrl);
			this.streamingEditor = editor;

			// Insert the streaming block at the cursor. The visible header
			// (`---` + `*Live transcript:*`) marks the start; the invisible
			// HTML-comment sentinel marks the end. All further streaming
			// operations find the end sentinel via content.indexOf() so they
			// stay correct regardless of what the user types elsewhere in the
			// note during recording.
			//
			// Block shape:
			//     \n\n---
			//     *Live transcript:*
			//     <streamed content>
			//     <!-- live-transcript-end -->
			const cursor = editor.getCursor();
			const block = `\n\n---\n*Live transcript:*\n\n${LIVE_END_SENTINEL}\n`;
			editor.replaceRange(block, cursor);

			// Length of the currently-displayed partial (un-finalized) turn.
			// Partials are the last N characters immediately before LIVE_END_SENTINEL.
			let currentPartialLen = 0;

			this.streamingSocket.onmessage = (event) => {
				const msg = JSON.parse(event.data);
				if (msg.type === "Turn" && msg.transcript) {
					if (msg.end_of_turn) {
						// Remove any in-flight partial then append the final line.
						if (currentPartialLen > 0) {
							this.replaceLivePartial(editor, currentPartialLen, "");
							currentPartialLen = 0;
						}
						this.appendLive(editor, msg.transcript + "\n");
					} else {
						// Update in place — replace the existing partial chars with the new partial.
						const newPartial = msg.transcript;
						if (currentPartialLen > 0) {
							this.replaceLivePartial(editor, currentPartialLen, newPartial);
						} else {
							this.appendLive(editor, newPartial);
						}
						currentPartialLen = newPartial.length;

						const preview = newPartial.length > 50 ? newPartial.slice(0, 50) + "…" : newPartial;
						this.setStatusBar(`🔴 ${preview}`);
					}
				} else if (msg.type === "Begin") {
					console.log("AI Notetaker: Streaming session started, id:", msg.id);
				} else if (msg.type === "Termination") {
					console.log("AI Notetaker: Streaming session ended, duration:", msg.audio_duration_seconds, "s");
				}
			};

			this.streamingSocket.onerror = (err) => {
				console.error("AI Notetaker: Streaming WebSocket error:", err);
			};

			this.streamingSocket.onclose = () => {
				console.log("AI Notetaker: Streaming WebSocket closed");
			};

			// Set up audio capture for streaming (separate from PCM capture)
			// AssemblyAI v3 expects raw binary 16-bit PCM at 16kHz
			this.streamingAudioContext = new AudioContext({ sampleRate: 16000 });

			const workletCode = `
class StreamingSendProcessor extends AudioWorkletProcessor {
	constructor() { super(); this.buffer = []; }
	process(inputs) {
		const ch = inputs[0]?.[0];
		if (!ch) return true;
		for (let i = 0; i < ch.length; i++) this.buffer.push(ch[i]);
		if (this.buffer.length >= 2048) {
			this.port.postMessage(new Float32Array(this.buffer));
			this.buffer = [];
		}
		return true;
	}
}
registerProcessor('streaming-send-processor', StreamingSendProcessor);
`;
			const blob = new Blob([workletCode], { type: "application/javascript" });
			const url = URL.createObjectURL(blob);
			await this.streamingAudioContext.audioWorklet.addModule(url);
			URL.revokeObjectURL(url);

			this.streamingSource = this.streamingAudioContext.createMediaStreamSource(stream);
			this.streamingWorkletNode = new AudioWorkletNode(this.streamingAudioContext, "streaming-send-processor");

			this.streamingWorkletNode.port.onmessage = (e: MessageEvent) => {
				if (!this.streamingSocket || this.streamingSocket.readyState !== WebSocket.OPEN) return;
				const float32 = e.data as Float32Array;
				// Convert Float32 to Int16 PCM
				const int16 = new Int16Array(float32.length);
				for (let i = 0; i < float32.length; i++) {
					const s = Math.max(-1, Math.min(1, float32[i]));
					int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
				}
				// Send as raw binary (v3 expects binary frames)
				this.streamingSocket.send(int16.buffer);
			};

			this.streamingSource.connect(this.streamingWorkletNode);

			console.log("AI Notetaker: Streaming transcription started");
		} catch (err) {
			console.error("AI Notetaker: Failed to start streaming transcription:", err);
			new Notice("AI Notetaker: Live transcription unavailable — will transcribe after recording.", 5000);
			this.stopStreamingTranscription();
		}
	}

	private stopStreamingTranscription() {
		if (this.streamingSocket) {
			if (this.streamingSocket.readyState === WebSocket.OPEN) {
				this.streamingSocket.send(JSON.stringify({ type: "Terminate" }));
			}
			this.streamingSocket.close();
			this.streamingSocket = null;
		}
		if (this.streamingWorkletNode) {
			this.streamingWorkletNode.disconnect();
			this.streamingWorkletNode = null;
		}
		if (this.streamingSource) {
			this.streamingSource.disconnect();
			this.streamingSource = null;
		}
		if (this.streamingAudioContext) {
			this.streamingAudioContext.close().catch(() => {});
			this.streamingAudioContext = null;
		}
		this.streamingEditor = null;
	}

	stopRecording(editor: Editor) {
		if (!this.mediaRecorder) return;

		const fullPcm = this.fullPcmRecording;

		// Stop the streaming socket (so no more turns come in) but leave the
		// live transcript BLOCK in place in the editor. It stays visible during
		// the "transcribing / generating note" phase and is replaced atomically
		// once the final transcript is ready (see transcribeAndInsert's final
		// markdown insertion, which calls replaceLiveTranscriptBlock).
		this.stopStreamingTranscription();

		this.mediaRecorder.onstop = async () => {
			this.mediaRecorder?.stream.getTracks().forEach((t) => t.stop());

			const audioBlob = new Blob(this.audioChunks, {
				type: this.mediaRecorder?.mimeType ?? "audio/webm",
			});
			this.audioChunks = [];
			this.isRecording = false;
			this.updateRibbonIcon();
			this.refreshSpeakerPanel();

			this.stopAudioCapture();

			await this.transcribeAndInsert(audioBlob, editor, fullPcm);
		};

		this.mediaRecorder.stop();
		this.setStatusBar("⏳ Transcribing…");
		new Notice("AI Notetaker: Recording stopped. Transcribing…");
	}

	// -- AssemblyAI integration ----------------------------------------------

	private async transcribeAndInsert(
		audioBlob: Blob,
		editor: Editor,
		fullPcm: Int16Array,
	) {
		const apiKey = this.settings.assemblyAiApiKey;

		try {
			const uploadUrl = await this.uploadAudio(audioBlob, apiKey);
			const transcriptId = await this.submitTranscription(uploadUrl, apiKey);
			const result = await this.pollTranscription(transcriptId, apiKey);

			// Try to auto-recognize speakers via bridge if we have PCM and enrolled profiles
			let speakerMap: Map<string, string> | null = null;
			if (fullPcm.length > 0 && result.utterances?.length) {
				const utterances = result.utterances.map((u) => ({
					speaker: u.speaker,
					start: u.start,
					end: u.end,
					text: u.text,
				}));
				try {
					const matches = await this.bridgeClient.recognizeSpeakers(fullPcm, utterances);
					if (Object.keys(matches).length > 0) {
						speakerMap = new Map(Object.entries(matches));
						console.log("AI Notetaker: Bridge-recognized speakers:", Object.fromEntries(speakerMap));
					}
				} catch (err) {
					console.warn("AI Notetaker: Speaker recognition unavailable (daemon down?):", err);
					new Notice("PlaudNoteTaker daemon not running — speaker features unavailable", 5000);
				}
			}

			// Build the transcript text with speaker names
			const transcriptText = this.buildTranscriptText(result.utterances ?? [], speakerMap);

			// Generate Gemini summary if API key is configured
			let geminiOutput = "";
			if (this.settings.geminiApiKey) {
				this.setStatusBar("🤖 Generating notes…");
				try {
					const template = await this.loadSelectedTemplate();
					geminiOutput = await this.callGemini(transcriptText, template);
				} catch (err: any) {
					console.error("AI Notetaker: Gemini error:", err);
					geminiOutput = `> ⚠️ Gemini summarization failed: ${err.message}\n`;
				}
			}

			// Build the final markdown. If a streaming live-transcript block is
			// present in the note (user had streaming enabled), replace the
			// whole block atomically with the final markdown — this is what
			// swaps the "*Live transcript:*" section for the cleaned, diarized
			// version. If no streaming block exists (streaming was off), fall
			// back to inserting at the current cursor position.
			const markdown = this.buildMarkdown(transcriptText, geminiOutput, speakerMap);
			const replaced = this.replaceLiveTranscriptBlock(editor, markdown);
			if (!replaced) {
				this.insertIntoEditor(editor, markdown);
			}

			// Store for the auto-popup (and for deferred sidebar-button flow if the
			// user dismisses the popup and comes back later in the same session).
			this.lastUtterances = result.utterances ?? null;
			this.lastFullPcm = fullPcm.length > 0 ? fullPcm : null;

			this.setStatusBar("");

			const hasUnlabeled = result.utterances?.some(
				(u) => !speakerMap?.has(u.speaker),
			);
			if (hasUnlabeled) {
				new Notice("AI Notetaker: Transcription complete — identify speakers.");
				// Auto-popup: the user's mental context is loaded right after
				// recording, so opening the modal immediately is the right time
				// to prompt for names. If they dismiss, they can re-trigger via
				// the sidebar's "Label Speakers in Note" button.
				//
				// Small delay lets insertIntoEditor's Obsidian editor update
				// finish before labelSpeakersInNote reads the content back.
				setTimeout(() => {
					void this.labelSpeakersInNote(editor);
				}, 50);
			} else {
				new Notice("AI Notetaker: Transcription complete!");
			}
		} catch (err: any) {
			console.error("AI Notetaker error:", err);
			const message = err instanceof Error ? err.message : String(err);
			const errorBlock = `\n> ⚠️ Transcription failed: ${message}\n`;
			// If a live-transcript block is still sitting in the note from a
			// streaming session, replace it with the error. Otherwise insert
			// at the cursor. Same atomic-swap pattern as the success path —
			// user never sees both a live block and an error at once.
			const replaced = this.replaceLiveTranscriptBlock(editor, errorBlock);
			if (!replaced) {
				this.insertIntoEditor(editor, errorBlock);
			}
			this.setStatusBar("");
			new Notice(`AI Notetaker: Transcription failed — ${message}`);
		}
	}

	// -- Label Speakers (unified flow for daemon + plugin notes) ---------------

	/**
	 * Single entry point for labeling speakers in any note.
	 * Routes based on note content:
	 *
	 *   • DAEMON NOTE (written by the PlaudNoteTaker daemon, has the
	 *     `> **Unknown Speakers**` callout): modal with blank inputs
	 *     (daemon already auto-matched what it could; leftovers are genuinely
	 *     unknown to Eagle). On save, write names into the callout, then POST
	 *     /label-speakers so the daemon does substitution + enrollment from
	 *     Plaud audio (the robust persistent path).
	 *
	 *   • PLUGIN-RECORDED NOTE (no callout): modal pre-filled with live
	 *     recognition suggestions via /speakers/recognize (if in-memory PCM
	 *     is still available). On save, do text substitution in the editor
	 *     + enroll any newly-named speakers via /speakers/enroll with PCM
	 *     sliced to that speaker's utterances capped at 30s.
	 */
	async labelSpeakersInNote(editor: Editor) {
		const content = editor.getValue();
		const file = this.app.workspace.getActiveFile();

		// Daemon notes carry the "Unknown Speakers" callout near the top.
		const isDaemonNote = /^>\s*\*\*Unknown Speakers\*\*/m.test(content);

		if (isDaemonNote) {
			await this.labelDaemonNote(editor, content, file);
		} else {
			await this.labelPluginNote(editor, content);
		}
	}

	/**
	 * Daemon-note flow: note was written by the always-on daemon from a Plaud
	 * recording. Plaud audio is the source of truth for enrollment (daemon
	 * re-downloads it). Plugin's job is just to collect the names and hand off.
	 */
	private async labelDaemonNote(
		editor: Editor,
		content: string,
		file: TFile | null,
	) {
		if (!file) {
			new Notice("AI Notetaker: No active file.");
			return;
		}

		// Parse speaker labels out of the callout. The daemon writes them as
		// `> - Speaker A:` (with optional trailing text if user already typed).
		const calloutLinePattern = /^>\s*-\s*Speaker ([A-Z]):\s*(.*)$/gm;
		const labels: string[] = [];
		const existingNames = new Map<string, string>();
		let m: RegExpExecArray | null;
		while ((m = calloutLinePattern.exec(content)) !== null) {
			labels.push(m[1]);
			if (m[2].trim()) existingNames.set(m[1], m[2].trim());
		}

		if (labels.length === 0) {
			new Notice("AI Notetaker: Unknown Speakers callout is empty or malformed.");
			return;
		}

		await this.refreshEnrolledSpeakers();

		// Modal gets blank inputs (daemon's auto-matcher already had a shot; any
		// names it could pin, it did). If the user had typed names into the
		// callout before clicking the sidebar button, respect those as pre-fills.
		const speakerMap = await new Promise<Map<string, string> | null>((resolve) => {
			const modal = new SpeakerMappingModal(
				this.app,
				this,
				labels.sort(),
				null,
				existingNames.size > 0 ? existingNames : null,
				resolve,
			);
			modal.open();
		});

		if (!speakerMap || speakerMap.size === 0) return;

		// Write names into the callout so the daemon's parseUnknownSpeakers()
		// finds them. Replace each `> - Speaker A:` line with `> - Speaker A: <name>`.
		let newContent = content;
		for (const [label, name] of speakerMap) {
			const lineRe = new RegExp(`^(>\\s*-\\s*Speaker ${label}:)\\s*.*$`, "m");
			newContent = newContent.replace(lineRe, `$1 ${name}`);
		}
		await this.app.vault.modify(file, newContent);

		// POST to daemon. It parses the callout, substitutes names throughout
		// the note body, removes the callout, and enrolls new speakers from
		// Plaud audio — single atomic operation, same code path as the CLI
		// `plaud label` command.
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			new Notice("AI Notetaker: desktop-only (need filesystem access).");
			return;
		}
		const absPath = adapter.getFullPath(file.path);

		try {
			const result = await this.bridgeClient.labelSpeakers(absPath);
			if (result.ok) {
				new Notice(
					`AI Notetaker: matched ${result.matched}, enrolled ${result.enrolled}.`,
				);
				await this.refreshEnrolledSpeakers();
			} else {
				new Notice(`AI Notetaker: ${result.error ?? "label failed"}.`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("Daemon not running")) {
				new Notice("PlaudNoteTaker daemon is not running — cannot enroll speakers.");
			} else {
				new Notice(`AI Notetaker: ${msg}`);
			}
		}
	}

	/**
	 * Plugin-note flow: in-Obsidian recording. We own the PCM (if still in
	 * memory from this session) and do text editing via the Obsidian editor
	 * directly. Per-speaker enrollment goes through /speakers/enroll with
	 * pre-sliced PCM (30s cap per speaker to conserve Picovoice quota).
	 */
	private async labelPluginNote(editor: Editor, content: string) {
		// Find `**Speaker X:**` patterns in the transcript.
		const pattern = /\*\*Speaker ([A-Z]):\*\*/g;
		const labels = new Set<string>();
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			labels.add(match[1]);
		}
		if (labels.size === 0) {
			new Notice("AI Notetaker: No speaker labels found in this note.");
			return;
		}
		const sortedLabels = [...labels].sort();

		// Preview utterances from the transcript (one per speaker) for the modal.
		const previewUtterances: AssemblyAIUtterance[] = [];
		for (const label of sortedLabels) {
			const lineRe = new RegExp(`\\*\\*Speaker ${label}:\\*\\*\\s*(.+)`, "m");
			const lm = lineRe.exec(content);
			if (lm) {
				previewUtterances.push({ speaker: label, text: lm[1], start: 0, end: 0 });
			}
		}

		// Live recognition against enrolled profiles — only possible if we still
		// have the PCM and utterances from this session's recording. Daemon does
		// the matching; plugin just pre-fills the modal.
		let suggestions: Map<string, string> | null = null;
		if (this.lastFullPcm && this.lastUtterances?.length) {
			try {
				const utts = this.lastUtterances.map((u) => ({
					speaker: u.speaker,
					start: u.start,
					end: u.end,
					text: u.text,
				}));
				const matches = await this.bridgeClient.recognizeSpeakers(this.lastFullPcm, utts);
				if (Object.keys(matches).length > 0) {
					suggestions = new Map(Object.entries(matches));
				}
			} catch {
				/* daemon down — modal opens without suggestions */
			}
		}

		await this.refreshEnrolledSpeakers();

		const speakerMap = await new Promise<Map<string, string> | null>((resolve) => {
			const modal = new SpeakerMappingModal(
				this.app,
				this,
				sortedLabels,
				previewUtterances.length > 0 ? previewUtterances : null,
				suggestions,
				resolve,
			);
			modal.open();
		});

		if (!speakerMap || speakerMap.size === 0) return;

		// Text substitution in the editor — **Speaker X:** → **Name:**.
		let newContent = editor.getValue();
		for (const [label, name] of speakerMap) {
			newContent = newContent.replace(
				new RegExp(`\\*\\*Speaker ${label}:\\*\\*`, "g"),
				`**${name}:**`,
			);
		}
		editor.setValue(newContent);

		// Enrollment: only for names that the user TYPED in (i.e., weren't
		// already pre-filled from recognition). A pre-filled name that the user
		// didn't change is an already-enrolled speaker — substitution only, no
		// re-enrollment.
		if (this.lastFullPcm && this.lastUtterances) {
			await this.enrollNewSpeakersFromMeeting(
				speakerMap,
				suggestions,
				this.lastUtterances,
				this.lastFullPcm,
			);
		} else {
			// PCM is gone (user reopened Obsidian, labeling an old plugin note).
			new Notice("No speaker profile created — recording audio no longer available.");
		}

		new Notice("AI Notetaker: speaker labels updated.");
	}

	// -- Enrollment from meeting audio (via bridge) --------------------------

	/**
	 * Enroll newly-named speakers from the just-recorded PCM.
	 *
	 * Skip rules (to avoid wasted Picovoice quota on redundant enrollments):
	 *   • Name the user ACCEPTED from a recognition suggestion (unchanged pre-fill)
	 *     → already enrolled → skip.
	 *   • Name that already exists in the enrolled list (user typed a known name)
	 *     → re-enrollment is pointless → skip.
	 *   • Only names the user TYPED (different from or absent from suggestions)
	 *     are treated as new enrollments.
	 *
	 * PCM is pre-sliced to that speaker's utterances, capped at 30 seconds
	 * total — matches the CLI's MAX_SECONDS_PER_SPEAKER quota-conservation
	 * behavior and keeps the HTTP payload small.
	 */
	private async enrollNewSpeakersFromMeeting(
		speakerMap: Map<string, string>,
		suggestions: Map<string, string> | null,
		utterances: AssemblyAIUtterance[],
		fullPcm: Int16Array,
	) {
		const existingNames = new Set(this.enrolledSpeakerNames);

		// Normalize utterances to bridge-client shape for sliceSpeakerPcm.
		const utts = utterances.map((u) => ({
			speaker: u.speaker,
			start: u.start,
			end: u.end,
			text: u.text,
		}));

		for (const [label, name] of speakerMap) {
			// Accept-suggestion path: user left the pre-fill unchanged → already enrolled.
			if (suggestions?.get(label) === name) continue;
			// Name is already enrolled (user typed a known name for a different speaker).
			if (existingNames.has(name)) continue;

			const speakerPcm = sliceSpeakerPcm(fullPcm, utts, label, 30);
			if (speakerPcm.length === 0) continue;

			try {
				new Notice(`AI Notetaker: enrolling "${name}"…`);
				const result = await this.bridgeClient.enrollSpeaker(name, speakerPcm);
				if (result.ok) {
					this.enrolledSpeakerNames = [...this.enrolledSpeakerNames, name];
					this.refreshSpeakerPanel();
					new Notice(`AI Notetaker: "${name}" enrolled.`);
				} else {
					new Notice(
						`AI Notetaker: not enough audio to enroll "${name}" (${result.error ?? "need longer utterances"}).`,
					);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("Daemon not running")) {
					new Notice("PlaudNoteTaker daemon not running — cannot enroll speakers.");
					return; // bail entire loop; daemon is unreachable
				}
				new Notice(`AI Notetaker: failed to enroll "${name}": ${msg}`);
			}
		}
	}

	// -- AssemblyAI API calls ------------------------------------------------

	private async uploadAudio(blob: Blob, apiKey: string): Promise<string> {
		const arrayBuffer = await blob.arrayBuffer();
		console.log("AI Notetaker: uploading audio, size:", arrayBuffer.byteLength);
		const response = await requestUrl({
			url: "https://api.assemblyai.com/v2/upload",
			method: "POST",
			headers: {
				authorization: apiKey,
				"Content-Type": "application/octet-stream",
			},
			body: arrayBuffer,
		});
		return response.json.upload_url;
	}

	private async submitTranscription(audioUrl: string, apiKey: string): Promise<string> {
		const response = await requestUrl({
			url: "https://api.assemblyai.com/v2/transcript",
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
		return response.json.id;
	}

	private async pollTranscription(
		transcriptId: string,
		apiKey: string,
	): Promise<AssemblyAITranscriptResponse> {
		const url = `https://api.assemblyai.com/v2/transcript/${transcriptId}`;

		while (true) {
			const response = await requestUrl({
				url,
				headers: { authorization: apiKey },
			});

			if (response.status >= 400) {
				throw new Error(`Polling failed (HTTP ${response.status})`);
			}

			const data: AssemblyAITranscriptResponse = response.json;

			if (data.status === "completed") return data;
			if (data.status === "error") throw new Error(data.error ?? "Unknown transcription error");

			await this.sleep(3000);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	// -- Template loading ----------------------------------------------------

	/** Load the selected prompt template. Returns template string. */
	private async loadSelectedTemplate(): Promise<string> {
		const selected = this.settings.selectedTemplate;
		if (selected === "Default") return DEFAULT_TEMPLATE;

		const folder = this.settings.templateFolder;
		const filePath = `${folder}/${selected}.md`;
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file && "extension" in file) {
			const content = await this.app.vault.read(file as any);
			if (content.trim()) return content;
		}

		console.warn(`AI Notetaker: Template "${filePath}" not found, using Default.`);
		return DEFAULT_TEMPLATE;
	}

	/** List available template names from the template folder. */
	async listTemplates(): Promise<string[]> {
		const names = ["Default"];
		const folder = this.settings.templateFolder;
		const abstractFolder = this.app.vault.getAbstractFileByPath(folder);
		if (abstractFolder && "children" in abstractFolder) {
			for (const child of (abstractFolder as any).children) {
				if (child.extension === "md") {
					names.push(child.basename);
				}
			}
		}
		return names;
	}

	// -- Gemini integration --------------------------------------------------

	private async callGemini(transcriptText: string, template: string): Promise<string> {
		const prompt = template.includes("{{transcript}}")
			? template.replace("{{transcript}}", transcriptText)
			: template + "\n\n## Transcript:\n" + transcriptText;

		const model = this.settings.geminiModel || "gemini-2.5-flash-lite";
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.settings.geminiApiKey}`;

		console.log("AI Notetaker: calling Gemini", model);
		const response = await requestUrl({
			url,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
			}),
		});

		const candidate = response.json?.candidates?.[0];
		if (!candidate) {
			throw new Error("No response from Gemini");
		}

		const text = candidate.content?.parts?.[0]?.text ?? "";
		console.log("AI Notetaker: Gemini response length:", text.length);
		return text;
	}

	// -- Transcript & Markdown builder ---------------------------------------

	/** Build plain-text transcript with speaker names for Gemini input. */
	private buildTranscriptText(
		utterances: AssemblyAIUtterance[],
		speakerMap: Map<string, string> | null,
	): string {
		if (utterances.length === 0) return "No transcript available.";
		return utterances
			.map((u) => {
				const name = speakerMap?.get(u.speaker) ?? `Speaker ${u.speaker}`;
				return `${name}: ${u.text}`;
			})
			.join("\n");
	}

	/** Build final markdown: Gemini notes + raw transcript. */
	private buildMarkdown(
		transcriptText: string,
		geminiOutput: string,
		speakerMap: Map<string, string> | null,
	): string {
		const now = new Date();
		const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
		const time = now.toTimeString().slice(0, 5);

		let title = "Meeting Notes";
		let notesBody = geminiOutput.trim();

		// Extract title from Gemini output if it starts with "# "
		if (notesBody.startsWith("# ")) {
			const newlineIdx = notesBody.indexOf("\n");
			if (newlineIdx > 0) {
				title = notesBody.slice(2, newlineIdx).trim();
				notesBody = notesBody.slice(newlineIdx + 1).trim();
			} else {
				title = notesBody.slice(2).trim();
				notesBody = "";
			}
		}

		const lines: string[] = [
			"",
			"---",
			`## ${title}`,
			`*${date} at ${time}*`,
			"",
		];

		if (notesBody) {
			lines.push(notesBody);
		} else if (!geminiOutput) {
			lines.push("*No Gemini API key configured — set one in AI Notetaker settings for AI-generated notes.*");
		}

		lines.push("");
		lines.push("---");
		lines.push("");
		lines.push("### Transcript");
		lines.push("");

		// Raw transcript with speaker labels (markdown bold)
		for (const line of transcriptText.split("\n")) {
			// Convert "Speaker A: text" to "**Speaker A:** text"
			const colonIdx = line.indexOf(": ");
			if (colonIdx > 0) {
				const speaker = line.slice(0, colonIdx);
				const text = line.slice(colonIdx + 2);
				lines.push(`**${speaker}:** ${text}`);
			} else {
				lines.push(line);
			}
			lines.push("");
		}

		lines.push("---");
		lines.push("");

		return lines.join("\n");
	}

	private insertIntoEditor(editor: Editor, text: string) {
		const cursor = editor.getCursor();
		editor.replaceRange(text, cursor);
	}
}

// ---------------------------------------------------------------------------
// Audio helpers (local — no Eagle dependency)
// ---------------------------------------------------------------------------

/** Downsample Float32 audio from one sample rate to another. */
function downsamplePcm(
	input: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	if (fromRate === toRate) return input;
	const ratio = fromRate / toRate;
	const length = Math.round(input.length / ratio);
	const result = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		result[i] = input[Math.round(i * ratio)];
	}
	return result;
}

/** Convert Float32 [-1,1] audio to Int16 PCM. */
function float32ToInt16(input: Float32Array): Int16Array {
	const output = new Int16Array(input.length);
	for (let i = 0; i < input.length; i++) {
		const s = Math.max(-1, Math.min(1, input[i]));
		output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return output;
}

// ---------------------------------------------------------------------------
// Speaker Mapping Modal
// ---------------------------------------------------------------------------

class SpeakerMappingModal extends Modal {
	private plugin: AINotetakerPlugin;
	private speakerLabels: string[];
	private utterances: AssemblyAIUtterance[] | null;
	private suggestions: Map<string, string> | null;
	private resolve: (result: Map<string, string> | null) => void;
	private resolved = false;
	private nameInputs: Map<string, HTMLInputElement> = new Map();

	constructor(
		app: any,
		plugin: AINotetakerPlugin,
		speakerLabels: string[],
		utterances: AssemblyAIUtterance[] | null,
		suggestions: Map<string, string> | null,
		resolve: (result: Map<string, string> | null) => void,
	) {
		super(app);
		this.plugin = plugin;
		this.speakerLabels = speakerLabels;
		this.utterances = utterances;
		this.suggestions = suggestions;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Identify Speakers" });

		const existingNames = this.plugin.getEnrolledSpeakerNames();

		for (const label of this.speakerLabels) {
			const sample = this.utterances?.find((u) => u.speaker === label);
			const preview = sample
				? sample.text.length > 80
					? sample.text.slice(0, 80) + "…"
					: sample.text
				: "";

			const row = contentEl.createEl("div");
			row.style.cssText = "margin-bottom:14px;";

			const labelEl = row.createEl("div");
			labelEl.style.cssText = "font-weight:600;margin-bottom:4px;";
			labelEl.setText(`Speaker ${label}`);

			if (preview) {
				const previewEl = row.createEl("div");
				previewEl.style.cssText =
					"font-size:0.85em;color:var(--text-muted);margin-bottom:6px;font-style:italic;";
				previewEl.setText(`"${preview}"`);
			}

			const input = row.createEl("input", { type: "text" });
			input.style.cssText = "width:100%;";
			input.placeholder = `Speaker ${label}`;

			// Pre-fill with bridge-recognized match (if any). User types over
			// to override, or leaves as-is to accept the suggestion. No
			// separate accept/reject UI — typing IS the decision.
			const suggestion = this.suggestions?.get(label);
			if (suggestion) {
				input.value = suggestion;
			}

			// Autocomplete against existing enrolled speakers.
			if (existingNames.length > 0) {
				const listId = `speaker-list-${label}`;
				const datalist = row.createEl("datalist");
				datalist.id = listId;
				for (const name of existingNames) {
					datalist.createEl("option", { value: name });
				}
				input.setAttribute("list", listId);
			}

			this.nameInputs.set(label, input);
		}

		const btnContainer = contentEl.createEl("div");
		btnContainer.style.cssText =
			"display:flex;gap:8px;margin-top:16px;justify-content:flex-end;";

		const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		});

		const saveBtn = btnContainer.createEl("button", { text: "Save" });
		saveBtn.addClass("mod-cta");
		saveBtn.addEventListener("click", () => {
			const result = new Map<string, string>();
			for (const [label, input] of this.nameInputs) {
				const name = input.value.trim();
				if (name) {
					result.set(label, name);
				}
			}
			this.resolved = true;
			this.resolve(result);
			this.close();
		});
	}

	onClose() {
		if (!this.resolved) {
			this.resolve(null);
		}
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Enroll Speaker Modal (standalone — uses bridge)
// ---------------------------------------------------------------------------

class EnrollSpeakerModal extends Modal {
	private plugin: AINotetakerPlugin;
	private stream: MediaStream | null = null;
	private enrollPcmAudioContext: AudioContext | null = null;
	private enrollPcmWorkletNode: AudioWorkletNode | null = null;
	private enrollPcmSource: MediaStreamAudioSourceNode | null = null;
	private pcmBuffer: Int16Array = new Int16Array(0);
	private isRecording = false;
	private speakerName = "";

	constructor(app: any, plugin: AINotetakerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Enroll Speaker" });
		contentEl.createEl("p", {
			text: 'Enter a name and record 10-15 seconds of the speaker talking. (Tip: speakers are also auto-enrolled when you name them via "Label Speakers" after a meeting.)',
		});

		new Setting(contentEl)
			.setName("Speaker Name")
			.addText((text) =>
				text.setPlaceholder("e.g. Alice").onChange((value) => {
					this.speakerName = value.trim();
				}),
			);

		const statusEl = contentEl.createEl("p", { text: "" });
		const progressEl = contentEl.createEl("div");
		progressEl.style.cssText =
			"width:100%;height:20px;background:#333;border-radius:4px;overflow:hidden;margin:10px 0;display:none;";
		const progressBar = progressEl.createEl("div");
		progressBar.style.cssText = "width:0%;height:100%;background:#5b8;transition:width 0.3s;";

		const btnContainer = contentEl.createEl("div");
		btnContainer.style.cssText = "display:flex;gap:8px;margin-top:12px;";

		const startBtn = btnContainer.createEl("button", { text: "Start Recording" });
		startBtn.addClass("mod-cta");
		const stopBtn = btnContainer.createEl("button", { text: "Stop & Enroll" });
		stopBtn.disabled = true;

		const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		startBtn.addEventListener("click", async () => {
			if (!this.speakerName) {
				new Notice("Please enter a speaker name.");
				return;
			}
			if (this.isRecording) return;

			startBtn.disabled = true;
			this.isRecording = true;
			statusEl.setText("🔴 Recording… speak now! Click Stop when done.");
			progressEl.style.display = "block";
			progressBar.style.width = "50%"; // indeterminate

			try {
				this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
				this.pcmBuffer = new Int16Array(0);
				const EAGLE_SAMPLE_RATE = 16000;

				this.enrollPcmAudioContext = new AudioContext();
				const nativeSampleRate = this.enrollPcmAudioContext.sampleRate;

				const workletCode = `
class PCMEnrollProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.buffer = new Float32Array(4096);
		this.writeIndex = 0;
	}
	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		for (let i = 0; i < channel.length; i++) {
			this.buffer[this.writeIndex++] = channel[i];
			if (this.writeIndex >= this.buffer.length) {
				this.port.postMessage(this.buffer.slice());
				this.writeIndex = 0;
			}
		}
		return true;
	}
}
registerProcessor('pcm-enroll-processor', PCMEnrollProcessor);
`;
				const blob = new Blob([workletCode], { type: "application/javascript" });
				const url = URL.createObjectURL(blob);
				await this.enrollPcmAudioContext.audioWorklet.addModule(url);
				URL.revokeObjectURL(url);

				this.enrollPcmSource = this.enrollPcmAudioContext.createMediaStreamSource(this.stream);
				this.enrollPcmWorkletNode = new AudioWorkletNode(this.enrollPcmAudioContext, "pcm-enroll-processor");

				this.enrollPcmWorkletNode.port.onmessage = (e: MessageEvent) => {
					if (!this.isRecording) return;
					const float32 = e.data as Float32Array;
					const resampled = downsamplePcm(float32, nativeSampleRate, EAGLE_SAMPLE_RATE);
					const int16 = float32ToInt16(resampled);
					const newBuf = new Int16Array(this.pcmBuffer.length + int16.length);
					newBuf.set(this.pcmBuffer);
					newBuf.set(int16, this.pcmBuffer.length);
					this.pcmBuffer = newBuf;
				};

				this.enrollPcmSource.connect(this.enrollPcmWorkletNode);
				stopBtn.disabled = false;
			} catch (err: any) {
				console.error("Enrollment setup error:", err);
				statusEl.setText(`Error: ${err.message}`);
				this.isRecording = false;
				startBtn.disabled = false;
			}
		});

		stopBtn.addEventListener("click", async () => {
			if (!this.isRecording) return;
			this.isRecording = false;
			stopBtn.disabled = true;
			this.cleanupRecording();

			statusEl.setText("Enrolling with daemon…");
			progressBar.style.width = "80%";

			try {
				const result = await this.plugin.bridgeClient.enrollSpeaker(this.speakerName, this.pcmBuffer);
				if (result.ok) {
					await this.plugin.refreshEnrolledSpeakers();
					this.plugin.refreshSpeakerPanel();
					progressBar.style.width = "100%";
					statusEl.setText(`✅ "${this.speakerName}" enrolled successfully!`);
					new Notice(`AI Notetaker: Speaker "${this.speakerName}" enrolled!`);
					setTimeout(() => this.close(), 1500);
				} else {
					statusEl.setText(`Enrollment failed: ${result.error ?? "Not enough audio"}`);
					new Notice(`AI Notetaker: Not enough audio to enroll "${this.speakerName}" — record 10-15 seconds.`);
					startBtn.disabled = false;
				}
			} catch (err: any) {
				console.error("Enrollment error:", err);
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("Daemon not running")) {
					statusEl.setText("PlaudNoteTaker daemon not running.");
					new Notice("PlaudNoteTaker daemon not running — speaker features unavailable");
				} else {
					statusEl.setText(`Error: ${msg}`);
				}
				startBtn.disabled = false;
			}
		});
	}

	private cleanupRecording() {
		if (this.enrollPcmWorkletNode) {
			this.enrollPcmWorkletNode.disconnect();
			this.enrollPcmWorkletNode = null;
		}
		if (this.enrollPcmSource) {
			this.enrollPcmSource.disconnect();
			this.enrollPcmSource = null;
		}
		if (this.enrollPcmAudioContext) {
			this.enrollPcmAudioContext.close().catch(() => {});
			this.enrollPcmAudioContext = null;
		}
		if (this.stream) {
			this.stream.getTracks().forEach((t) => t.stop());
			this.stream = null;
		}
	}

	onClose() {
		this.isRecording = false;
		this.cleanupRecording();
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Manage Speakers Modal (uses bridge)
// ---------------------------------------------------------------------------

class ManageSpeakersModal extends Modal {
	private plugin: AINotetakerPlugin;

	constructor(app: any, plugin: AINotetakerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.renderContent();
	}

	private async renderContent() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Speaker Profiles" });

		// Fetch names from bridge
		let names: string[] = [];
		try {
			names = await this.plugin.bridgeClient.listSpeakers();
			this.plugin.enrolledSpeakerNames = names; // update cache
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("Daemon not running")) {
				contentEl.createEl("p", {
					text: "PlaudNoteTaker daemon not running — cannot load speaker profiles.",
					cls: "setting-item-description",
				});
			} else {
				contentEl.createEl("p", {
					text: `Error loading speakers: ${msg}`,
					cls: "setting-item-description",
				});
			}
			return;
		}

		if (names.length === 0) {
			contentEl.createEl("p", {
				text: 'No speaker profiles enrolled yet. Speakers are automatically enrolled when you name them via "Label Speakers" after a meeting.',
			});
			return;
		}

		for (const name of names) {
			new Setting(contentEl)
				.setName(name)
				.setDesc("Enrolled speaker profile")
				.addButton((btn) =>
					btn
						.setButtonText("Delete")
						.setWarning()
						.onClick(async () => {
							try {
								await this.plugin.bridgeClient.deleteSpeaker(name);
								await this.plugin.refreshEnrolledSpeakers();
								new Notice(`AI Notetaker: Deleted speaker "${name}".`);
								this.plugin.refreshSpeakerPanel();
								this.renderContent();
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								new Notice(`Failed to delete speaker: ${msg}`);
							}
						}),
				);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Speaker Panel (sidebar view — uses bridge)
// ---------------------------------------------------------------------------

class SpeakerPanelView extends ItemView {
	private plugin: AINotetakerPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: AINotetakerPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return SPEAKER_VIEW_TYPE;
	}

	getDisplayText() {
		return "Speakers";
	}

	getIcon() {
		return "users";
	}

	async onOpen() {
		this.refresh();
	}

	refresh() {
		const container = this.containerEl.children[1];
		container.empty();

		// -- Recording status --
		const statusSection = container.createEl("div", { cls: "ai-notetaker-panel-section" });
		statusSection.style.cssText = "padding:12px;border-bottom:1px solid var(--background-modifier-border);";

		if (this.plugin.isRecording) {
			const statusRow = statusSection.createEl("div");
			statusRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
			const dot = statusRow.createEl("span");
			dot.style.cssText = "width:10px;height:10px;border-radius:50%;background:#e55;display:inline-block;";
			statusRow.createEl("span", { text: "Recording…" });

			const stopBtn = statusSection.createEl("button", { text: "Stop Recording" });
			stopBtn.style.cssText = "width:100%;";
			stopBtn.addEventListener("click", () => {
				const editor = this.plugin.getMarkdownEditor();
				if (editor) {
					this.plugin.stopRecording(editor);
				} else {
					new Notice("AI Notetaker: Open a note to stop recording into.");
				}
			});
		} else {
			const recBtn = statusSection.createEl("button", { text: "Start Recording" });
			recBtn.addClass("mod-cta");
			recBtn.style.cssText = "width:100%;";
			recBtn.addEventListener("click", () => {
				if (!this.plugin.getMarkdownEditor()) {
					new Notice("AI Notetaker: Open a note first.");
					return;
				}
				this.plugin.startRecording();
			});
		}

		// -- Enrolled speakers (from cache) --
		const speakerSection = container.createEl("div", { cls: "ai-notetaker-panel-section" });
		speakerSection.style.cssText = "padding:12px;";

		const headerRow = speakerSection.createEl("div");
		headerRow.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
		headerRow.createEl("h6", { text: "Enrolled Speakers" }).style.margin = "0";

		const names = this.plugin.getEnrolledSpeakerNames();

		if (names.length === 0) {
			speakerSection.createEl("p", {
				text: "No speakers enrolled yet. Record a meeting and use \"Label Speakers\" to enroll.",
				cls: "setting-item-description",
			});
		} else {
			for (const name of names) {
				const row = speakerSection.createEl("div");
				row.style.cssText =
					"display:flex;justify-content:space-between;align-items:center;padding:4px 0;";

				row.createEl("span", { text: name });

				const deleteBtn = row.createEl("button");
				deleteBtn.style.cssText = "padding:2px 6px;font-size:0.8em;";
				setIcon(deleteBtn, "trash-2");
				deleteBtn.setAttribute("aria-label", `Delete ${name}`);
				deleteBtn.addEventListener("click", async () => {
					try {
						await this.plugin.bridgeClient.deleteSpeaker(name);
						await this.plugin.refreshEnrolledSpeakers();
						new Notice(`AI Notetaker: Deleted "${name}".`);
						this.refresh();
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						if (msg.includes("Daemon not running")) {
							new Notice("PlaudNoteTaker daemon not running — speaker features unavailable");
						} else {
							new Notice(`Failed to delete: ${msg}`);
						}
					}
				});
			}
		}

		// -- Actions --
		const actionSection = container.createEl("div", { cls: "ai-notetaker-panel-section" });
		actionSection.style.cssText = "padding:12px;border-top:1px solid var(--background-modifier-border);";

		const enrollBtn = actionSection.createEl("button", { text: "Enroll Speaker" });
		enrollBtn.style.cssText = "width:100%;margin-bottom:6px;";
		enrollBtn.addEventListener("click", () => {
			new EnrollSpeakerModal(this.plugin.app, this.plugin).open();
		});

		const labelBtn = actionSection.createEl("button", { text: "Label Speakers in Note" });
		labelBtn.style.cssText = "width:100%;";
		labelBtn.addEventListener("click", () => {
			const editor = this.plugin.getMarkdownEditor();
			if (editor) {
				this.plugin.labelSpeakersInNote(editor);
			} else {
				new Notice("AI Notetaker: Open a note first.");
			}
		});
	}

	async onClose() {}
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class AINotetakerSettingTab extends PluginSettingTab {
	plugin: AINotetakerPlugin;

	constructor(app: any, plugin: AINotetakerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "AI Notetaker Settings" });
		containerEl.createEl("p", {
			text: "API keys are automatically fetched from the PlaudNoteTaker daemon when it is running. The values below are cached fallbacks used when the daemon is offline.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("AssemblyAI API Key")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("Enter your AssemblyAI API key. Get one at ");
					frag.createEl("a", {
						text: "assemblyai.com",
						href: "https://www.assemblyai.com",
					});
					frag.appendText(".");
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder("your-api-key")
					.setValue(this.plugin.settings.assemblyAiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.assemblyAiApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Picovoice AccessKey (cached)")
			.setDesc(
				"Fetched from daemon. Speaker recognition is handled by the PlaudNoteTaker daemon — this is for reference only.",
			)
			.addText((text) =>
				text
					.setPlaceholder("fetched from daemon")
					.setValue(this.plugin.settings.picovoiceAccessKey)
					.setDisabled(true),
			);

		// -- Streaming settings --

		containerEl.createEl("h3", { text: "Live Transcription" });

		new Setting(containerEl)
			.setName("Enable live transcription")
			.setDesc(
				"Show a real-time transcript while recording. ⚠️ This uses AssemblyAI's streaming API in addition to the batch API, which will roughly double your AssemblyAI costs per recording.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStreaming)
					.onChange(async (value) => {
						this.plugin.settings.enableStreaming = value;
						await this.plugin.saveSettings();
					}),
			);

		// -- Gemini settings --

		containerEl.createEl("h3", { text: "Gemini (AI Notes)" });

		new Setting(containerEl)
			.setName("Gemini API Key")
			.setDesc(
				createFragment((frag) => {
					frag.appendText("For AI-generated meeting notes. Get one at ");
					frag.createEl("a", {
						text: "aistudio.google.com",
						href: "https://aistudio.google.com/apikey",
					});
					frag.appendText(". Leave blank to skip AI notes.");
				}),
			)
			.addText((text) =>
				text
					.setPlaceholder("your-gemini-api-key")
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Gemini Model")
			.setDesc("Which Gemini model to use for generating notes.")
			.addDropdown((drop) =>
				drop
					.addOptions({
						"gemini-2.5-flash": "Gemini 2.5 Flash",
						"gemini-2.5-pro": "Gemini 2.5 Pro",
						"gemini-3.1-pro": "Gemini 3.1 Pro",
					})
					.setValue(this.plugin.settings.geminiModel)
					.onChange(async (value) => {
						this.plugin.settings.geminiModel = value;
						await this.plugin.saveSettings();
					}),
		);

		const folderSetting = new Setting(containerEl)
			.setName("Template Folder")
			.setDesc("Vault folder containing prompt template .md files. Templates use {{transcript}} as placeholder.");

		// Build folder dropdown from all vault folders
		const folders: string[] = [""];
		this.app.vault.getAllLoadedFiles().forEach((f) => {
			if (f instanceof TFolder && f.path !== "/") {
				folders.push(f.path);
			}
		});
		folders.sort();

		folderSetting.addDropdown((drop) => {
			drop.addOption("", "(none)");
			for (const f of folders) {
				if (f) drop.addOption(f, f);
			}
			drop.setValue(this.plugin.settings.templateFolder);
			drop.onChange(async (value) => {
				this.plugin.settings.templateFolder = value;
				await this.plugin.saveSettings();
				// Refresh to update template list
				this.display();
			});
		});

		// Template dropdown — populated async
		const templateSetting = new Setting(containerEl)
			.setName("Selected Template")
			.setDesc("Choose which prompt template to use for AI notes generation.");

		this.plugin.listTemplates().then((templates) => {
			templateSetting.addDropdown((drop) => {
				for (const t of templates) {
					drop.addOption(t, t);
				}
				drop.setValue(this.plugin.settings.selectedTemplate);
				drop.onChange(async (value) => {
					this.plugin.settings.selectedTemplate = value;
					await this.plugin.saveSettings();
				});
			});
		});

		// -- Speaker settings --

		containerEl.createEl("h3", { text: "Speaker Recognition" });

		new Setting(containerEl)
			.setName("Speaker Profiles")
			.setDesc("Profiles are managed by the PlaudNoteTaker daemon. Use the \"Manage Speaker Profiles\" command to view or remove enrolled speakers.");

		new Setting(containerEl)
			.setName("Refresh from Daemon")
			.setDesc("Re-fetch API keys and speaker list from the running daemon.")
			.addButton((btn) =>
				btn.setButtonText("Refresh").onClick(async () => {
					await this.plugin.refreshApiKeys();
					await this.plugin.refreshEnrolledSpeakers();
					new Notice("AI Notetaker: Refreshed from daemon.");
					this.display();
				}),
			);
	}
}
