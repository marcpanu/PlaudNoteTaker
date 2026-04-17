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
} from "obsidian";
import { createBridgeClient, BridgeClient } from "./bridge-client";

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
		// Try active view first
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active.editor;
		// Fall back: iterate all leaves and find one with an editor
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

	// -- Streaming transcription ---------------------------------------------

	private async startStreamingTranscription(stream: MediaStream, editor: Editor) {
		const apiKey = this.settings.assemblyAiApiKey;

		try {
			// Connect directly with API key as token (v3 API supports this)
			const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-streaming-english&token=${apiKey}`;
			this.streamingSocket = new WebSocket(wsUrl);
			this.streamingEditor = editor;

			// Mark the insert position in the editor
			const cursor = editor.getCursor();
			const header = "\n\n---\n*Live transcript:*\n\n";
			editor.replaceRange(header, cursor);
			this.streamingInsertPos = { line: cursor.line, ch: cursor.ch };
			this.streamingText = header;

			// Track the current partial turn text so we can update it in-place
			let currentPartial = "";

			this.streamingSocket.onmessage = (event) => {
				const msg = JSON.parse(event.data);
				if (msg.type === "Turn" && msg.transcript) {
					if (msg.end_of_turn) {
						// Final turn — remove partial and append final line
						if (currentPartial.length > 0) {
							const partialStart = editor.posToOffset(this.streamingInsertPos!) + this.streamingText.length - currentPartial.length;
							const from = editor.offsetToPos(partialStart);
							const to = editor.offsetToPos(partialStart + currentPartial.length);
							editor.replaceRange("", from, to);
							this.streamingText = this.streamingText.slice(0, -currentPartial.length);
							currentPartial = "";
						}
						const line = msg.transcript + "\n";
						const insertOffset = editor.posToOffset(this.streamingInsertPos!) + this.streamingText.length;
						const insertPos = editor.offsetToPos(insertOffset);
						editor.replaceRange(line, insertPos);
						this.streamingText += line;
					} else {
						// Partial turn — update in place
						const newPartial = msg.transcript;
						if (currentPartial.length > 0) {
							const partialStart = editor.posToOffset(this.streamingInsertPos!) + this.streamingText.length - currentPartial.length;
							const from = editor.offsetToPos(partialStart);
							const to = editor.offsetToPos(partialStart + currentPartial.length);
							editor.replaceRange(newPartial, from, to);
							this.streamingText = this.streamingText.slice(0, -currentPartial.length) + newPartial;
						} else {
							const insertOffset = editor.posToOffset(this.streamingInsertPos!) + this.streamingText.length;
							const insertPos = editor.offsetToPos(insertOffset);
							editor.replaceRange(newPartial, insertPos);
							this.streamingText += newPartial;
						}
						currentPartial = newPartial;

						// Update status bar with preview
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

		// Capture streaming state before cleanup
		const hadStreaming = this.streamingSocket !== null;
		const streamingStartPos = this.streamingInsertPos;
		const streamingLen = this.streamingText.length;

		// Stop streaming
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

			// If we had streaming, remove the live transcript before inserting final
			if (hadStreaming && streamingStartPos && streamingLen > 0) {
				const startOffset = editor.posToOffset(streamingStartPos);
				const from = editor.offsetToPos(startOffset);
				const to = editor.offsetToPos(startOffset + streamingLen);
				editor.replaceRange("", from, to);
			}

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

			// Build and insert final markdown
			const markdown = this.buildMarkdown(transcriptText, geminiOutput, speakerMap);
			this.insertIntoEditor(editor, markdown);

			// Store data for deferred "Label Speakers" command
			this.lastUtterances = result.utterances ?? null;
			this.lastFullPcm = fullPcm.length > 0 ? fullPcm : null;

			this.setStatusBar("");

			const hasUnlabeled = result.utterances?.some(
				(u) => !speakerMap?.has(u.speaker),
			);
			if (hasUnlabeled) {
				new Notice(
					'AI Notetaker: Done! Use "Label Speakers" to name unknown speakers.',
					8000,
				);
			} else {
				new Notice("AI Notetaker: Transcription complete!");
			}
		} catch (err: any) {
			console.error("AI Notetaker error:", err);
			const message = err instanceof Error ? err.message : String(err);
			const errorBlock = `\n> ⚠️ Transcription failed: ${message}\n`;
			this.insertIntoEditor(editor, errorBlock);
			this.setStatusBar("");
			new Notice(`AI Notetaker: Transcription failed — ${message}`);
		}
	}

	// -- Label Speakers (deferred) -------------------------------------------

	async labelSpeakersInNote(editor: Editor) {
		const content = editor.getValue();

		// Find all "**Speaker X:**" patterns in the note
		const speakerPattern = /\*\*Speaker ([A-Z]):\*\*/g;
		const labels = new Set<string>();
		let match;
		while ((match = speakerPattern.exec(content)) !== null) {
			labels.add(match[1]);
		}

		if (labels.size === 0) {
			new Notice("AI Notetaker: No speaker labels found in this note.");
			return;
		}

		const speakerLabels = [...labels].sort();

		// Build preview text for each speaker from the note content
		const previewUtterances: AssemblyAIUtterance[] = [];
		for (const label of speakerLabels) {
			const linePattern = new RegExp(`\\*\\*Speaker ${label}:\\*\\*\\s*(.+)`, "g");
			const lineMatch = linePattern.exec(content);
			if (lineMatch) {
				previewUtterances.push({
					speaker: label,
					text: lineMatch[1],
					start: 0,
					end: 0,
				});
			}
		}

		// Build suggestions from bridge recognition if we have stored PCM
		let suggestions: Map<string, string> | null = null;
		if (this.lastFullPcm && this.lastUtterances?.length) {
			try {
				const utterances = this.lastUtterances.map((u) => ({
					speaker: u.speaker,
					start: u.start,
					end: u.end,
					text: u.text,
				}));
				const matches = await this.bridgeClient.recognizeSpeakers(this.lastFullPcm, utterances);
				if (Object.keys(matches).length > 0) {
					suggestions = new Map(Object.entries(matches));
				}
			} catch {
				// daemon down — no suggestions
			}
		}

		// Refresh enrolled names for autocomplete
		await this.refreshEnrolledSpeakers();

		const speakerMap = await new Promise<Map<string, string> | null>((resolve) => {
			const modal = new SpeakerMappingModal(
				this.app,
				this,
				speakerLabels,
				previewUtterances.length > 0 ? previewUtterances : null,
				suggestions,
				resolve,
			);
			modal.open();
		});

		if (!speakerMap || speakerMap.size === 0) return;

		// Replace "**Speaker X:**" with "**Name:**" in the editor
		let newContent = editor.getValue();
		for (const [label, name] of speakerMap) {
			const pattern = new RegExp(`\\*\\*Speaker ${label}:\\*\\*`, "g");
			newContent = newContent.replace(pattern, `**${name}:**`);
		}
		editor.setValue(newContent);

		// Enroll new speakers from meeting audio via bridge if available
		if (this.lastFullPcm && this.lastUtterances) {
			await this.enrollNewSpeakersFromMeeting(
				speakerMap,
				this.lastUtterances,
				this.lastFullPcm,
			);
		}

		new Notice("AI Notetaker: Speaker labels updated!");
	}

	// -- Enrollment from meeting audio (via bridge) --------------------------

	private async enrollNewSpeakersFromMeeting(
		speakerMap: Map<string, string>,
		utterances: AssemblyAIUtterance[],
		fullPcm: Int16Array,
	) {
		const existingNames = new Set(this.enrolledSpeakerNames);

		for (const [label, name] of speakerMap) {
			if (existingNames.has(name)) continue;

			const segments = utterances
				.filter((u) => u.speaker === label)
				.map((u) => ({ startMs: u.start, endMs: u.end }));

			if (segments.length === 0) continue;

			// Extract and concatenate PCM for this speaker's utterances
			const EAGLE_SAMPLE_RATE = 16000;
			const speakerPcmChunks: Int16Array[] = [];
			for (const seg of segments) {
				const startSample = Math.floor((seg.startMs / 1000) * EAGLE_SAMPLE_RATE);
				const endSample = Math.min(
					Math.ceil((seg.endMs / 1000) * EAGLE_SAMPLE_RATE),
					fullPcm.length,
				);
				if (endSample > startSample) {
					speakerPcmChunks.push(fullPcm.slice(startSample, endSample));
				}
			}
			if (speakerPcmChunks.length === 0) continue;

			// Concatenate all chunks
			const totalLength = speakerPcmChunks.reduce((sum, c) => sum + c.length, 0);
			const speakerPcm = new Int16Array(totalLength);
			let offset = 0;
			for (const chunk of speakerPcmChunks) {
				speakerPcm.set(chunk, offset);
				offset += chunk.length;
			}

			try {
				new Notice(`AI Notetaker: Enrolling "${name}" from meeting audio…`);
				const result = await this.bridgeClient.enrollSpeaker(name, speakerPcm);

				if (result.ok) {
					this.enrolledSpeakerNames = [...this.enrolledSpeakerNames, name];
					this.refreshSpeakerPanel();
					new Notice(`AI Notetaker: "${name}" enrolled successfully!`);
				} else {
					new Notice(`AI Notetaker: Not enough audio to enroll "${name}" — try a longer meeting.`);
				}
			} catch (err) {
				console.error(`AI Notetaker: Failed to enroll "${name}":`, err);
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("Daemon not running")) {
					new Notice("PlaudNoteTaker daemon not running — speaker features unavailable");
				} else {
					new Notice(`AI Notetaker: Failed to enroll "${name}".`);
				}
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
		contentEl.createEl("p", {
			text: "Name each speaker. New names will be enrolled for future recognition.",
			cls: "setting-item-description",
		});

		const existingNames = this.plugin.getEnrolledSpeakerNames();

		for (const label of this.speakerLabels) {
			// Find a sample utterance for this speaker
			const sample = this.utterances?.find((u) => u.speaker === label);
			const preview = sample
				? sample.text.length > 80
					? sample.text.slice(0, 80) + "…"
					: sample.text
				: "";

			const row = contentEl.createEl("div");
			row.style.cssText = "margin-bottom:16px;";

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
			input.placeholder = "Enter name (e.g. Alice)";

			const suggestion = this.suggestions?.get(label);
			if (suggestion) {
				input.value = suggestion;
			}

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
		btnContainer.style.cssText = "display:flex;gap:8px;margin-top:16px;justify-content:flex-end;";

		const skipBtn = btnContainer.createEl("button", { text: "Skip" });
		skipBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		});

		const applyBtn = btnContainer.createEl("button", { text: "Apply" });
		applyBtn.addClass("mod-cta");
		applyBtn.addEventListener("click", () => {
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
