# Codebase Concerns

**Analysis Date:** 2026-04-16

## Tech Debt

**External binary dependency on ffmpeg:**
- Issue: Pipeline requires ffmpeg to be installed separately for audio conversion (WAV) and PCM decoding. No graceful fallback if ffmpeg is missing at runtime.
- Files: `src/audio.ts`, `src/cli/init.ts`, `src/cli/test.ts`
- Impact: Users must install ffmpeg via `brew install ffmpeg`. Pipeline fails silently if ffmpeg is uninstalled after init. Cross-platform support (Windows, Linux) requires different installation instructions.
- Fix approach: Use a Node.js native audio library (e.g., `wav`, `pcm-utils`) to eliminate ffmpeg dependency, or bundle a minimal ffmpeg binary. At minimum, add ffmpeg availability check to the polling loop with graceful shutdown.

**Temporary file cleanup is not guaranteed:**
- Issue: `src/audio.ts` creates temporary files via `tmpdir()` and attempts cleanup with try-catch blocks that silently ignore errors. If a process terminates unexpectedly, temp files accumulate.
- Files: `src/audio.ts` (lines 30, 33, 79, 82)
- Impact: Disk space leaks over long-running `plaud start` sessions. Affects users running this continuously on macOS (tmpdir files may not be auto-deleted).
- Fix approach: Use `fs.promises.mkstemp()` with guaranteed cleanup via finally block or a temp directory cleanup routine on startup.

**Synchronous file system operations in polling loop:**
- Issue: `src/state.ts` uses synchronous `readFileSync()` and `writeFileSync()` for loaded/saving processed IDs, recording metadata, and history.
- Files: `src/state.ts` (loadProcessedIds, saveProcessedId, loadMetaStore, saveMetaStore, loadHistory, saveHistory)
- Impact: Each poll blocks the event loop while reading/writing JSON files. With large history files (100+ entries), this can cause noticeable pauses in responsiveness.
- Fix approach: Migrate file I/O to `fs.promises` or a lightweight async queue (e.g., `pqueue`) to prevent blocking. Cache processed IDs in memory with periodic flush.

**No validation of vault path or Obsidian compatibility:**
- Issue: `src/config.ts` loads `VAULT_PATH` from .env but does not validate it exists or is a valid Obsidian vault (has `.obsidian` folder).
- Files: `src/config.ts`, `src/pipeline.ts` (line 105)
- Impact: User can run `plaud start` with an invalid vault path and encounter silent failures when attempting to write notes. Folder scanning will fail gracefully but notes won't be written.
- Fix approach: Add vault validation in `loadConfig()` or as a separate step in `runStart()`. Check for `.obsidian` folder existence.

## Known Bugs

**Eagle speaker recognition throws silently on partial enrollment:**
- Symptoms: `src/speakers/eagle.ts` enrollSpeaker() logs a console.warn at line 174 instead of using the consistent `log` module, making it easy to miss when debugging speaker enrollment failures.
- Files: `src/speakers/eagle.ts` (line 174)
- Trigger: When a speaker has less than ~10s of audio, enrollment reaches 0-100% and returns null with a warning.
- Workaround: Check logs carefully during `plaud label` command or increase speaker utterance count.
- Fix approach: Use the `log` module consistently (import and use `warn()` instead of `console.warn()`).

**Missing error context in Gemini API failures:**
- Symptoms: `src/summarization/gemini.ts` line 56 assumes `data.candidates[0].content.parts[0].text` exists without bounds checking. If Gemini returns a malformed response, this crashes with an opaque "Cannot read property" error.
- Files: `src/summarization/gemini.ts` (lines 55-56)
- Trigger: Gemini API response with empty candidates array or missing content/parts fields.
- Workaround: None — will crash the pipeline.
- Fix approach: Add defensive checks: `if (!data?.candidates?.[0]?.content?.parts?.[0]?.text)` with a clear error message.

**AssemblyAI retry logic only checks first error status word:**
- Symptoms: `src/transcription/assemblyai.ts` line 45 uses `result.error?.includes("Internal server error")` to decide if an error is retryable. If AssemblyAI changes error message format, retries stop working.
- Files: `src/transcription/assemblyai.ts` (line 45)
- Trigger: AssemblyAI returns error with different wording (e.g., "Server error" instead of "Internal server error").
- Workaround: Retry manually with `plaud start` again.
- Fix approach: Retry on 5xx status codes instead of parsing error text, or use a list of known retryable error strings.

**Gemini folder selection has no fallback for unparseable output:**
- Symptoms: `src/summarization/gemini.ts` parseSummaryOutput() searches for "FOLDER:" in first 5 lines. If Gemini doesn't output this line (e.g., due to prompt injection or unexpected behavior), folder extraction fails silently.
- Files: `src/summarization/gemini.ts` (lines 68-72)
- Trigger: Gemini response that doesn't start with "FOLDER:" or contains it outside the first 5 lines.
- Workaround: None — note is written to default `VAULT_NOTES_FOLDER`.
- Fix approach: Log when folder parsing fails and make it explicit in output format that the FOLDER line is required.

## Security Considerations

**API keys stored in plaintext .env file:**
- Risk: `.env` contains `PLAUD_BEARER_TOKEN`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, and `PICOVOICE_ACCESS_KEY`. If `.env` is committed to git or exposed, all API keys are compromised.
- Files: `.env` (user's local file, but see `.gitignore`)
- Current mitigation: `.gitignore` includes `.env`, preventing accidental commits. User's responsibility to protect local file.
- Recommendations: Add a note in `.env.example` and README warning against copying .env to shared machines. Consider optional `.env.local` pattern for per-machine overrides. For production deployments, use environment variables from CI/CD secrets instead.

**Audio files downloaded from Plaud are cached in memory only:**
- Risk: Large audio buffers (50+ MB) are held in memory during transcription. If a process crashes, audio is lost. However, no persistent audio cache exists.
- Files: `src/pipeline.ts` (line 32), `src/audio.ts`
- Current mitigation: Audio is not written to disk, only held in memory during processing.
- Recommendations: This is acceptable for privacy but document that local temp files may contain audio (via ffmpeg's temp directory). Advise users to ensure `/tmp` is on an encrypted volume if privacy is critical.

**PlaudClient does not validate SSL certificates explicitly:**
- Risk: Default Node.js fetch() validates SSL but no certificate pinning for Plaud or AssemblyAI APIs.
- Files: `src/plaud/client.ts`, `src/transcription/assemblyai.ts`, `src/summarization/gemini.ts`
- Current mitigation: Using standard HTTPS, relies on system certificate store.
- Recommendations: If used on restricted networks, ensure CA certificates are up to date. For high-security deployments, consider adding certificate pinning.

**Vault note files contain full transcript with speaker names:**
- Risk: Obsidian vault files (markdown) contain complete conversation transcripts with identified speaker names. If vault is synced to cloud (iCloud, OneDrive, Dropbox), sensitive conversations are exposed.
- Files: `src/notes/writer.ts` (lines 95-112)
- Current mitigation: None — transcripts are always included.
- Recommendations: Document this behavior. Consider adding an optional `INCLUDE_TRANSCRIPT=false` config flag to exclude transcript from notes, keeping only summary.

## Performance Bottlenecks

**Eagle speaker recognition scales linearly with audio per speaker:**
- Problem: `src/speakers/eagle.ts` processes up to 30 seconds of audio per speaker (MAX_SECONDS_PER_SPEAKER = 30). With 5+ speakers, this requires ~2.5 minutes of CPU-intensive processing.
- Files: `src/speakers/eagle.ts` (lines 5-8, 60-96)
- Cause: Eagle.process() must analyze every chunk of audio to match against all enrolled profiles. No built-in batching or parallel processing.
- Improvement path: Investigate if Eagle SDK supports batch processing or parallel profile matching. If not, consider processing speakers in parallel (Node.js Worker threads). Also revisit the 30-second limit — may be overly conservative.

**Polling loop waits for one recording to finish before fetching next batch:**
- Problem: `src/cli/start.ts` processes recordings sequentially in a loop. A slow transcription (20+ minutes for long audio) blocks polling of other new recordings.
- Files: `src/cli/start.ts` (lines 71-102)
- Cause: Awaiting each `processRecording()` before moving to next one.
- Improvement path: Use a worker queue (e.g., `pqueue`, Bull) to process multiple recordings in parallel with a configurable concurrency limit (e.g., max 2 concurrent transcriptions). Makes polling responsive and improves overall throughput.

**Vault folder scanning uses execSync (synchronous shell command):**
- Problem: `src/notes/vault.ts` getVaultFolderTree() calls `find` command synchronously. On large vaults with 1000+ folders, this can take 1-5 seconds.
- Files: `src/notes/vault.ts` (line 18)
- Cause: Synchronous shell command blocks entire poll cycle.
- Improvement path: Migrate to `fs.readdirSync()` with recursive directory traversal in Node.js, or use `fs.promises` with parallel directory listing.

**AssemblyAI polling with fixed 3-second interval:**
- Problem: `src/transcription/assemblyai.ts` pollTranscription() waits a fixed POLL_INTERVAL = 3000ms between checks. For short audio (< 1 min), this adds unnecessary latency.
- Files: `src/transcription/assemblyai.ts` (lines 18, 139)
- Cause: No backoff or smarter polling strategy.
- Improvement path: Use exponential backoff starting at 1 second, increasing to 5 seconds. Or check if AssemblyAI supports webhooks for completion notifications.

## Fragile Areas

**Text parsing of unknown speakers section is regex-based:**
- Files: `src/notes/writer.ts` (lines 129-131, 165)
- Why fragile: Regex `/^> - Speaker ([A-Z]):\s*(.+)$/gm` assumes exact markdown format. If user edits the blockquote (removes `>`, changes spacing, or nests it), parsing fails silently.
- Safe modification: Add validation to `parseUnknownSpeakers()` that logs when parsing finds 0 entries but file contains "Unknown Speakers" section. Store parsed data in a JSON frontmatter or dedicated file instead of relying on regex.
- Test coverage: No tests for malformed unknown speakers section.

**Gemini prompt injection via transcript text:**
- Files: `src/summarization/gemini.ts` (lines 34-36)
- Why fragile: Transcript is directly interpolated into the Gemini prompt. If a speaker in the recording says something like "FOLDER: /etc/passwd" or includes markdown formatting, it could confuse the prompt or inject instructions.
- Safe modification: Escape or quote the transcript text before inserting into the prompt template. Add explicit separators (e.g., `---TRANSCRIPT_START---` and `---TRANSCRIPT_END---`) to make boundaries clear to the LLM.
- Test coverage: No test cases for transcripts with prompt-like content.

**Speaker label assignment does not handle conflicts:**
- Files: `src/speakers/eagle.ts` (lines 105-131)
- Why fragile: assignSpeakers() sorts by score and greedily assigns profiles to speakers. If two speakers both match the same profile with equal confidence, the first one wins and the second gets no label. No conflict resolution strategy.
- Safe modification: Log when conflicts occur. Consider returning a confidence score alongside each assignment so the user can see ambiguity.
- Test coverage: No tests for multi-speaker matching with identical scores.

**Config loading throws on missing required vars but no help text:**
- Files: `src/config.ts` (line 14)
- Why fragile: If a required env var is missing, error message says "Run 'plaud init' to set up" but if user never ran `init` or deleted `.env`, the error appears without clear guidance.
- Safe modification: Catch config errors in all entry points and print the `.env.example` file or a formatted setup checklist.
- Test coverage: No integration tests for missing config scenarios.

## Scaling Limits

**In-memory JSON files grow without bounds:**
- Current capacity: `processed-recordings.json` stores all processed IDs forever. With 1 recording per day for 10 years, this is ~3,650 entries.
- Limit: JSON parsing becomes slow at 10,000+ entries. File size becomes noticeable at 100+ KB.
- Scaling path: Implement rolling logs (keep last 2 years of processed IDs, archive older ones) or use SQLite/LevelDB for state storage.

**Picovoice free tier quota (100 min/mo):**
- Current capacity: Pipeline uses ~0.5 min per speaker. Supports ~200 speaker-identification attempts per month.
- Limit: Quota resets monthly. If quota is exceeded, speaker recognition fails gracefully but user loses that feature until next month.
- Scaling path: Add a quota-tracking system that logs remaining Picovoice minutes. Warn user when approaching limit. No official paid tier for personal use (Picovoice commercial plans are sales-gated).

**Large audio files and memory usage:**
- Current capacity: Tested up to ~500 MB audio files. Each file is downloaded entirely into memory.
- Limit: Node.js process hits memory limits with multi-GB files. ffmpeg has a 500 MB buffer limit (hardcoded in `audio.ts`).
- Scaling path: Stream audio instead of loading entirely into memory. Use ffmpeg with piped streams instead of temp files.

## Dependencies at Risk

**@picovoice/eagle-node is a native module with platform-specific builds:**
- Risk: `eagle-node` requires building native code at install time. Breaks if build tools are missing or platform is unsupported (e.g., Windows ARM64).
- Current version: `^3.0.0` (allows minor/patch updates but not major version).
- Impact: `npm install` fails on some machines. No fallback if installation is incomplete.
- Migration plan: The Picovoice access key is optional (line 30 in config.ts), so speaker recognition gracefully disables if installation fails. Document this. Consider making eagle-node an optional peer dependency.

**AssemblyAI API response format is coupled to implementation:**
- Risk: If AssemblyAI changes their API response schema (utterances, speaker labels), transcription breaks.
- Current version: No version pinning — using latest API endpoint `/v2/transcript`.
- Impact: Changes to AssemblyAI API could silently break transcription (e.g., missing utterances).
- Migration plan: Add response validation schema (e.g., using zod) to catch unexpected API changes early.

**Gemini API is tied to a specific model version:**
- Risk: Gemini model defaults to `gemini-2.5-flash` (config.ts line 29) but can be overridden. If a model is deprecated, pipeline silently fails or behaves differently.
- Current version: Configurable via `GEMINI_MODEL` env var.
- Impact: If user specifies a deprecated model name, Gemini API returns 404 or empty response.
- Migration plan: Add model validation in init command that lists available models from Google. Support model aliasing (e.g., "latest" → actual model name).

## Missing Critical Features

**No support for concurrent recording processing:**
- Problem: Pipeline processes one recording at a time. If Plaud has 5 new recordings and transcription takes 10 minutes each, user waits 50 minutes for all to complete. Polling is blocked the entire time.
- Blocks: Users with high recording volume or slow internet.
- Suggested approach: Implement a job queue (Bull, RabbitMQ, or simple in-memory queue) to process up to N recordings in parallel. Default to 1 for safety, configurable via `MAX_CONCURRENT_JOBS` env var.

**No retry mechanism for failed individual notes:**
- Problem: If a recording fails to process (Gemini timeout, vault write error), it's marked as processed and never retried. User must manually re-run via `plaud label` or run `plaud start` again.
- Blocks: Unreliable processing with transient network issues.
- Suggested approach: Store failed processing attempts in `state.ts` with retry counts. Automatically retry failed recordings on next poll (up to 3 times).

**No webhook/push notifications for completion:**
- Problem: User must check the terminal to see when notes are generated. No integration with OS notifications or integrations (Slack, Discord).
- Blocks: Hands-off monitoring.
- Suggested approach: Add optional notification module for system notifications (macOS Notification Center via `node-notifier`). Support webhook callbacks for custom integrations.

**No dry-run or preview mode:**
- Problem: User can't see what a note will look like before it's written to the vault. If Gemini produces unexpected output or folder routing fails, the bad note is already in the vault.
- Blocks: Testing custom templates or configuration.
- Suggested approach: Add `plaud preview <recording-id>` command that processes a recording but writes output to stdout instead of vault file.

## Test Coverage Gaps

**No unit tests for core pipeline logic:**
- What's not tested: `src/pipeline.ts` orchestration, speaker recognition flow, vault folder tree parsing.
- Files: `src/pipeline.ts`
- Risk: Refactoring or adding features breaks the overall flow without catching it.
- Priority: High — the pipeline is the core business logic.

**No integration tests for external API interactions:**
- What's not tested: AssemblyAI transcription end-to-end, Gemini summarization with real vault folders, Picovoice enrollment.
- Files: `src/transcription/assemblyai.ts`, `src/summarization/gemini.ts`, `src/speakers/eagle.ts`, `src/plaud/client.ts`
- Risk: API changes, response format changes, or auth failures go undetected until user reports them.
- Priority: High — external APIs are the most fragile.

**No tests for error conditions and recovery:**
- What's not tested: Missing .env file, invalid vault path, AssemblyAI timeout, Gemini rate limiting, ffmpeg not installed, Picovoice quota exceeded.
- Files: `src/config.ts`, `src/audio.ts`, `src/transcription/assemblyai.ts`, `src/summarization/gemini.ts`, `src/cli/start.ts`
- Risk: Error handling code is never executed, silent failures occur.
- Priority: High — error handling is critical for reliability.

**No tests for markdown parsing and generation:**
- What's not tested: parseUnknownSpeakers() with malformed notes, applyLabels() with edge cases, transcript formatting with special characters.
- Files: `src/notes/writer.ts`
- Risk: Notes with unusual speaker names or transcript content break parsing.
- Priority: Medium — impacts user-facing output.

**No tests for state persistence:**
- What's not tested: Concurrent reads/writes of processed IDs, corrupted JSON files, file system permissions.
- Files: `src/state.ts`
- Risk: State corruption if two processes access the same files, or if file write is interrupted.
- Priority: Medium — affects long-running reliability.

---

*Concerns audit: 2026-04-16*
