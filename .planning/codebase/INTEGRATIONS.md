# External Integrations

**Analysis Date:** 2026-04-16

## APIs & External Services

**Audio Recording Device:**
- Plaud device API - Retrieves recorded audio from Plaud hardware device
  - SDK/Client: Custom implementation in `src/plaud/client.ts`
  - Auth: Bearer token via `PLAUD_BEARER_TOKEN` env var
  - API Base: `https://api.plaud.ai`
  - Methods:
    - `listDevices()` - Enumerate connected Plaud devices
    - `getRecordings()` - Fetch list of recordings with pagination (skip/limit)
    - `getTempUrl()` - Generate temporary download URLs for audio files
    - `downloadRecording()` - Download audio buffer from temporary URL
  - Audio format: Opus (preferred) or WAV (fallback)
  - Retry logic: 3 retries with exponential backoff on 500+ errors and rate limits (429)

**Transcription & Diarization:**
- AssemblyAI - Converts audio to text with speaker labels/diarization
  - SDK/Client: Custom fetch-based implementation in `src/transcription/assemblyai.ts`
  - Auth: API key via `ASSEMBLYAI_API_KEY` env var (header: `authorization`)
  - API Base: `https://api.assemblyai.com/v2`
  - Methods:
    - `uploadAudio()` - POST to `/upload` with audio buffer; returns upload URL
    - `submitTranscription()` - POST to `/transcript` with audio URL; uses speech_models: "universal-3-pro" with speaker_labels enabled
    - `pollTranscription()` - GET `/transcript/{id}` to poll job status; 3-second poll interval
  - Output: Utterances array with speaker labels, text, start/end millisecond timestamps
  - Retry: Up to 2 retries on retryable internal server errors
  - Supports: OGG, Opus, MP3, WAV, FLAC, M4A, AAC, WMA (MIME type detection)

**Language Model Summarization:**
- Google Gemini - Generates meeting notes and determines target vault folder
  - SDK/Client: Custom fetch-based implementation in `src/summarization/gemini.ts`
  - Auth: API key via `GEMINI_API_KEY` env var (passed in query parameter)
  - API Base: `https://generativelanguage.googleapis.com/v1beta/models`
  - Method: `{model}:generateContent` (POST)
  - Model: Configurable via `GEMINI_MODEL` env var; default: `gemini-2.5-flash`
  - Input: Multi-part prompt with template, transcript, and vault folder suggestions
  - Output parsing: Looks for "FOLDER:" line in first 5 lines of response to determine Obsidian target folder
  - Template injection: Replaces `{{transcript}}` and `{{vault_folders}}` placeholders in user-provided template

**Speaker Recognition:**
- Picovoice Eagle - Identifies speakers from audio using enrolled voice profiles
  - SDK/Client: @picovoice/eagle-node npm package v3.0.0
  - Auth: Access key via `PICOVOICE_ACCESS_KEY` env var (optional for basic operations)
  - Usage pattern in `src/speakers/eagle.ts`:
    - `recognizeSpeakers()` - Match AssemblyAI speaker labels against enrolled profiles
    - `enrollSpeaker()` - Create new voice profile from audio segments using EagleProfiler
    - Profile storage: ArrayBuffer serialized to base64 in JSON (in `src/speakers/profiles.ts`)
    - Sample rate: 16 kHz (extracted from Eagle instance)
    - Matching threshold: 0.3 (minimum score for speaker match)
    - Audio limits: 30 seconds per speaker to conserve 100 min/month free quota
    - Scoring: Aggregates Eagle confidence scores across multiple chunks; highest matches assigned first

## Data Storage

**Databases:**
- None (relational or managed database)

**File Storage:**
- Local filesystem only - No S3, Azure Blob, or cloud storage integration
- Data files: JSON-based state in `./data` directory (configurable via `DATA_DIR` env var)
  - `processed-recordings.json` - Set of file IDs already processed
  - `speaker-profiles.json` - Enrolled speaker voice profiles (ArrayBuffer as base64)
  - `recording-meta.json` - Metadata about processed recordings (date, folder, etc.)
  - `processing-history.json` - Historical processing logs

**Caching:**
- None - No Redis, Memcached, or in-memory cache library

## Authentication & Identity

**Auth Provider:**
- None - Service uses API key-based authentication
- Authentication approach: Bearer tokens and API keys passed to external services
  - Plaud: Bearer token in Authorization header
  - AssemblyAI: API key in authorization header
  - Gemini: API key in query parameter
  - Picovoice: Access key passed directly to SDK functions

## Note Storage

**Obsidian Vault:**
- Integration type: Filesystem-based markdown files
- Implementation: `src/notes/vault.ts` and `src/notes/writer.ts`
- Vault path: Configurable via `VAULT_PATH` env var (required)
- Note location: Determined by Gemini's "FOLDER:" output or fallback to `VAULT_NOTES_FOLDER` (default: "Meeting Notes")
- File format: Markdown (.md extension)
- File naming: `YYYY-MM-DD {sanitized-title}.md`
- Content structure:
  - H1 title extracted from Gemini output
  - Date and time metadata
  - Gemini-generated summary
  - Raw transcript with speaker names
  - Unknown speaker labels section (if any speakers not enrolled)
- Vault integration: Direct file write (no Obsidian API calls); reads vault folder structure via `find` command for LLM suggestions

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Datadog, or error tracking service)

**Logs:**
- Console logging via custom `src/log.ts` module
- Log levels: info, warning, error
- Stderr output for errors
- No persistent log files or aggregation

## CI/CD & Deployment

**Hosting:**
- Not applicable - CLI application (not deployed as service)

**CI Pipeline:**
- None detected (no GitHub Actions, GitLab CI, or other workflow files)

## Environment Configuration

**Required env vars:**
- `PLAUD_BEARER_TOKEN` - Bearer token for Plaud device API
- `ASSEMBLYAI_API_KEY` - API key for AssemblyAI transcription service
- `GEMINI_API_KEY` - API key for Google Gemini LLM
- `VAULT_PATH` - Absolute path to Obsidian vault root directory

**Optional env vars with defaults:**
- `GEMINI_MODEL` - LLM model name (default: "gemini-2.5-flash")
- `PICOVOICE_ACCESS_KEY` - Access key for speaker recognition (default: empty; optional)
- `VAULT_NOTES_FOLDER` - Fallback subfolder in vault for notes (default: "Meeting Notes")
- `TEMPLATES_PATH` - Absolute path to custom markdown templates (default: empty; uses built-in)
- `SELECTED_TEMPLATE` - Template filename without .md extension (default: "Default")
- `POLL_INTERVAL` - Polling interval in seconds (default: 60)
- `DATA_DIR` - Directory for local state files (default: "./data")

**Secrets location:**
- `.env` file in project root (loaded by `src/config.ts` via dotenv)
- Must be created during initialization; example in `.env.example`

## Webhooks & Callbacks

**Incoming:**
- None - No webhook endpoints exposed by application

**Outgoing:**
- None - No webhooks to external services; all integration is request-response based

## Rate Limiting & Quotas

**Picovoice Eagle:**
- Quota: 100 minutes/month (free tier)
- Mitigation: Limited to 30 seconds of audio per speaker label to conserve quota
- Implementation in `src/speakers/eagle.ts`: `MAX_SECONDS_PER_SPEAKER = 30`

**Plaud API:**
- Rate limiting: 429 response handled with Retry-After header; exponential backoff
- Implementation in `src/plaud/client.ts`: respects `Retry-After` header or 1s * 2^attempt delays

**AssemblyAI:**
- Polling: 3-second interval between status checks
- Timeout: No explicit timeout; will poll indefinitely until completion or error

**Gemini:**
- No explicit rate limiting in client code; relies on Gemini service limits

---

*Integration audit: 2026-04-16*
