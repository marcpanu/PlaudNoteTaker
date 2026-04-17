# Architecture

**Analysis Date:** 2026-04-16

## Pattern Overview

**Overall:** Modular pipeline with discrete processing stages.

The application follows a strict linear pipeline pattern: fetch audio → transcribe → recognize speakers → summarize → write notes. Each stage is independent, composable, and uses well-defined interfaces. The codebase is organized into functional domains (speakers, transcription, notes, etc.) that map directly to external services and processing steps.

**Key Characteristics:**
- Linear, sequential data transformation pipeline
- Strong separation between external service integrations (Plaud, AssemblyAI, Gemini, Eagle)
- Stateless processing with side effects isolated to file I/O (`state.ts`)
- CLI-driven entry points with no HTTP server or event loop
- Configuration centralized in environment variables

## Layers

**CLI Layer:**
- Purpose: Handle user commands and orchestrate top-level workflows
- Location: `src/cli/*.ts`
- Contains: Command handlers (`init`, `start`, `label`, `test`, `speakers`)
- Depends on: Config, logging, pipeline, state management
- Used by: `src/index.ts` (entrypoint dispatcher)

**Pipeline Orchestration:**
- Purpose: Coordinate the full recording processing workflow
- Location: `src/pipeline.ts`
- Contains: `processRecording()` function that chains all processing steps
- Depends on: Plaud client, transcription, summarization, notes writer, speaker recognition, audio conversion
- Used by: `src/cli/start.ts` (the polling loop)

**External Service Integration:**
- Purpose: Abstract communication with third-party APIs
- Locations: `src/plaud/`, `src/transcription/`, `src/summarization/`, `src/speakers/`
- Contains:
  - `src/plaud/client.ts`: HTTP wrapper around Plaud device API with retry logic
  - `src/transcription/assemblyai.ts`: AssemblyAI transcription with polling
  - `src/summarization/gemini.ts`: Google Gemini API for note summarization
  - `src/speakers/eagle.ts`: Picovoice Eagle speaker recognition and enrollment
- Depends on: fetch API, external libraries (@picovoice/eagle-node)
- Used by: Pipeline layer

**Data Processing & Transformation:**
- Purpose: Transform data between formats and layers
- Locations: `src/audio.ts`, `src/notes/writer.ts`, `src/notes/vault.ts`, `src/speakers/profiles.ts`
- Contains:
  - `src/audio.ts`: Audio format conversion (OGG → WAV, any format → PCM Int16) using ffmpeg
  - `src/notes/writer.ts`: Markdown generation, filename sanitization, speaker label parsing/application
  - `src/notes/vault.ts`: Vault directory introspection
  - `src/speakers/profiles.ts`: Speaker profile persistence and mapping
- Depends on: File system, external processes (ffmpeg)
- Used by: Pipeline, CLI (label command)

**State & Persistence:**
- Purpose: Track processed recordings and store metadata for cross-command access
- Location: `src/state.ts`
- Contains: Three JSON file stores:
  - `processed-recordings.json`: Set of recording IDs already processed (prevents re-processing)
  - `recording-meta.json`: Utterances and metadata keyed by note filepath (used by `plaud label` to enroll speakers)
  - `processing-history.json`: Recent processing events for summary display
- Depends on: File system only
- Used by: Pipeline, CLI commands

**Configuration & Logging:**
- Purpose: Environment-based config and timestamped console output
- Locations: `src/config.ts`, `src/log.ts`
- Contains:
  - `src/config.ts`: Loads required/optional env vars, throws on missing critical values
  - `src/log.ts`: Timestamped logging with elapsed time since startup
- Depends on: dotenv, process.env
- Used by: All layers

## Data Flow

**Recording Processing Flow (Main Pipeline):**

1. `plaud.ts`: Fetch new recordings from Plaud API, filter by processed IDs
2. `audio.ts`: Download raw audio buffer from Plaud (OGG/Opus format)
3. `audio.ts`: Convert to WAV using ffmpeg (AssemblyAI compatibility)
4. `assemblyai.ts`: Upload WAV, submit transcription job, poll for completion → `Utterance[]`
5. `eagle.ts`: Decode audio to PCM Int16, run speaker recognition against enrolled profiles
6. `profiles.ts`: Build speaker map (AssemblyAI label → name or "Speaker X")
7. `vault.ts`: Scan Obsidian vault folder structure for LLM context
8. `template.ts`: Load and populate Gemini prompt template with transcript
9. `gemini.ts`: Send to Gemini API for summarization → extract folder + markdown
10. `writer.ts`: Build final markdown note with headers, metadata, transcript, unknown speakers block
11. `state.ts`: Save recording metadata (utterances) for later enrollment via `plaud label`
12. File system: Write `.md` file to vault path

**Speaker Enrollment Flow (Label Command):**

1. `writer.ts`: Parse note file for filled-in speaker names
2. `state.ts`: Load recording metadata (utterances + timing)
3. `plaud/client.ts`: Download original recording audio
4. `audio.ts`: Decode to PCM Int16
5. `eagle.ts`: Enroll speaker for each label using configured segments
6. `profiles.ts`: Save enrolled profiles to JSON store
7. `writer.ts`: Apply name replacements throughout note, remove unknown speakers section if complete

**State Management:**

- **Processed IDs**: Linear append-only set. Prevents reprocessing same recording multiple times.
- **Recording Metadata**: Keyed by note filepath. Stores utterance timing so enrollment can extract speaker segments post-processing.
- **Processing History**: Append-only list of recent events. Used only for 72-hour summary display in polling output.
- No global mutable state; all state passed as function arguments or stored in files.

## Key Abstractions

**Utterance:**
- Purpose: Atomic unit of transcribed speech
- Examples: Returned by `src/transcription/assemblyai.ts`
- Pattern: `{ speaker: string, text: string, start: number, end: number }`
- Used for: Building transcripts, extracting speaker segments for enrollment, timing calculations

**PlaudRecording:**
- Purpose: Metadata about a recording on Plaud device
- Examples: `src/plaud/types.ts`
- Pattern: Device API response unmarshalled to TypeScript interface
- Used for: Filtering new recordings, downloading audio by ID, logging metadata

**SummaryResult:**
- Purpose: Parsed output from Gemini summarization
- Pattern: Extract first matching "FOLDER:" line, treat rest as markdown content
- Used for: Smart vault routing and note generation

**SpeakerMap:**
- Purpose: Bidirectional mapping of AssemblyAI speaker labels to human-readable names
- Pattern: `Map<string, string>` built from Eagle recognition or fallback to "Speaker A/B/C"
- Used for: Transcript generation, unknown speakers section, label application

## Entry Points

**`src/index.ts`:**
- Location: `src/index.ts` (shebang executable, registered as `plaud` CLI)
- Triggers: User runs `plaud <command>` from shell
- Responsibilities: Parse argv, dispatch to appropriate CLI handler

**`src/cli/start.ts` (runStart):**
- Triggers: `plaud start` command
- Responsibilities:
  - Load config and validate API connections
  - Run initial poll immediately
  - Start infinite polling loop with skipping lock to prevent concurrent polls
  - Display formatted summary of recent notes

**`src/cli/init.ts` (runInit):**
- Triggers: `plaud init` command
- Responsibilities:
  - Check ffmpeg dependency
  - Prompt for API keys and paths
  - Validate Plaud connection
  - Write `.env` file
  - Create initial data directory

**`src/cli/label.ts` (runLabel):**
- Triggers: `plaud label <filepath>` command
- Responsibilities:
  - Resolve note filepath (absolute, relative, or vault-relative)
  - Parse filled-in speaker names from note
  - Apply text replacements
  - Download recording and enroll voices if Picovoice configured

**`src/cli/test.ts` (runTest):**
- Triggers: `plaud test` command
- Responsibilities: Validate all configured API credentials and connections

**`src/cli/speakers.ts`:**
- Triggers: `plaud speakers list|delete <name>`
- Responsibilities: List enrolled speaker profiles or delete one

## Error Handling

**Strategy:** Fail-fast with detailed error messages, except for known edge cases.

**Patterns:**

1. **Critical failures stop execution**: Missing API keys, failed Plaud auth, ffmpeg not installed → exit with error message

2. **Graceful degradation for optional features**: 
   - Speaker recognition disabled if no Picovoice key → continue without it
   - Speaker recognition failed for a recording → log warning, continue processing
   - Vault folder scan failed → continue with empty folder list (LLM will route to default)

3. **Retry logic on transient errors**:
   - Plaud API rate limiting (429): Exponential backoff with Retry-After header support
   - Plaud API server errors (5xx): Exponential backoff up to 3 retries
   - AssemblyAI transcription errors marked "retryable": Retry up to 2 additional times
   - Network errors: Retry up to 3 times with exponential backoff

4. **Special case handling**:
   - Empty transcription (no spoken audio) → skip note generation but mark recording processed
   - No utterances found for speaker during enrollment → warn but continue

5. **Process signals**: Ctrl+C during polling loop exits cleanly (no special handler needed, OS handles)

## Cross-Cutting Concerns

**Logging:** 

- All log output via `src/log.ts` (not raw `console`)
- Timestamped with HH:MM:SS format + elapsed time since startup
- Three levels: `log()` (info), `warn()`, `error()`
- Nested operations use indentation in message strings (e.g., "  Transcribed: ...") for visual hierarchy

**Validation:**

- Configuration: `src/config.ts` throws immediately if required env vars missing
- API responses: Unmarshalled to TypeScript interfaces; raw JSON access avoided
- User input (CLI): Minimal — mostly filepaths and names, resolved and validated against filesystem

**Authentication:**

- All external APIs use bearer tokens or API keys from environment
- Plaud: Bearer token in Authorization header
- AssemblyAI: API key in authorization header
- Gemini: API key as query parameter
- Picovoice: Access key passed to Eagle constructor
- No inline credentials; all from `.env`

**Resource Management:**

- Audio processing: Temporary files in OS tmpdir, cleaned up after use or on error
- Eagle SDK: Explicitly released (`eagle.release()`) after processing
- ffmpeg: Spawned as child process, stdout/stderr captured, exit code checked

---

*Architecture analysis: 2026-04-16*
