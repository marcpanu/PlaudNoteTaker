# Coding Conventions

**Analysis Date:** 2026-04-16

## Naming Patterns

**Files:**
- Module files use lowercase with hyphens: `client.ts`, `profiles.ts`, `assemblyai.ts`, `eagle.ts`
- Type definition files: `types.ts` 
- CLI command files: `start.ts`, `init.ts`, `label.ts`, `speakers.ts`, `test.ts`
- Index files: `index.ts` for module entry points

**Functions:**
- camelCase for all functions: `loadConfig()`, `transcribeAudio()`, `processRecording()`
- Action-verb prefixes: `load*()`, `save*()`, `build*()`, `extract*()`, `run*()`, `parse*()`
- Private functions: also camelCase (no underscore prefix), declared as local/helper functions within modules
- Exported functions: documented with JSDoc when useful

**Variables:**
- camelCase for local variables and parameters: `audioBuffer`, `recordingDate`, `speakerMap`
- UPPER_SNAKE_CASE for constants: `DEFAULT_TEMPLATE`, `SCORE_THRESHOLD`, `MAX_RETRIES`, `POLL_INTERVAL`
- const for all immutable declarations (no let for reassignment unless necessary)

**Types:**
- PascalCase for interfaces and types: `PlaudClient`, `Utterance`, `Config`, `SpeakerProfiles`, `RecordingMeta`
- Suffix with names that indicate purpose: `Response`, `Result`, `Options`, `Meta`, `State`
- Generic properties on API response types use snake_case (matching API contracts): `start_time`, `file_md5`, `upload_url`, `data_file_list`

## Code Style

**Formatting:**
- No explicit formatter configured (no .prettierrc, .eslintrc, or editorconfig)
- Inferred style from codebase:
  - 2-space indentation
  - Line length: no strict limit observed, some lines ~90-100 chars
  - Semicolons: required (not optional)
  - Trailing commas: used in multi-line arrays/objects/parameters

**Linting:**
- No explicit linter configured in project root
- TypeScript strict mode enabled (`"strict": true` in tsconfig.json)

## Import Organization

**Order:**
1. Standard library imports: `import { readFileSync } from "fs"`
2. Third-party packages: `import { Eagle } from "@picovoice/eagle-node"`
3. Local imports with .js extension: `import { loadConfig } from "../config.js"`
4. Type imports: `import type { Config } from "../config.js"`

**Path Aliases:**
- No aliases configured in tsconfig.json
- Relative paths used throughout: `"../config.js"`, `"./speakers/profiles.js"`, `"./transcription/assemblyai.js"`
- All imports use explicit `.js` extension (ESM compliance)

**Example from `src/pipeline.ts`:**
```typescript
import type { PlaudRecording } from "./plaud/types.js";
import { PlaudClient } from "./plaud/client.js";
import { transcribeAudio } from "./transcription/assemblyai.js";
import { summarizeTranscript } from "./summarization/gemini.js";
import { log, warn } from "./log.js";
import type { Config } from "./config.js";
```

## Error Handling

**Patterns:**
- Throw `Error` with descriptive messages: `throw new Error("Transcription failed: " + result.error)`
- Catch blocks handle different error types: `if (error instanceof Error) { ... }`
- Distinguish retry-able vs fatal errors (see `src/transcription/assemblyai.ts`, lines 45-51)
- Graceful degradation: log warnings and continue, don't crash on non-critical failures
  - Speaker recognition failures: catch and warn, continue without it (`src/pipeline.ts`, lines 84-86)
  - Missing vault folders: catch and warn, use defaults (`src/pipeline.ts`, lines 104-108)

**Example from `src/cli/start.ts`:**
```typescript
try {
  const filePath = await processRecording(recording, plaudClient, config);
  saveProcessedId(config.dataDir, recording.id);
  // ...
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("no spoken audio")) {
    warn(`Skipping "${recording.filename}": no spoken audio detected`);
    // Mark as processed and continue
  } else {
    error(`Failed to process recording...`, err);
  }
}
```

## Logging

**Framework:** Custom logger in `src/log.ts` wrapping console methods

**Functions:**
- `log(...args)` - info-level messages with timestamp
- `warn(...args)` - warning messages with timestamp
- `error(...args)` - error messages with timestamp

**Patterns:**
- Always use the custom logger, never raw `console.log()`
- Timestamps include absolute time and elapsed seconds since startup: `[14:32:15 +3.2s]`
- Log progress in pipeline steps with indent formatting (two spaces): `log("  Processing...")`, `log("    Uploaded...")`
- User-facing messages via `console.log()` (not logged to timestamp)
- Warnings used for recoverable failures, errors for fatal ones

**Example from `src/pipeline.ts`:**
```typescript
import { log, warn } from "./log.js";

log(`Processing: "${recording.filename}" (${recordingDate.toLocaleDateString()})`);
log(`  Recording metadata: id=${recording.id} filetype=${recording.filetype}...`);
log("  Downloading audio...");
// ...
if (utterances.length === 0) {
  warn("  No utterances found, skipping note generation");
}
```

## Comments

**When to Comment:**
- Algorithm explanations or non-obvious logic
- Quotas/limits that impact code decisions
- External API contracts or quirks
- Complex regex patterns
- Memory/performance considerations

**JSDoc/TSDoc:**
- Used sparingly, mainly for public APIs and complex functions
- Single-line descriptions sufficient for most functions
- Example from `src/audio.ts`:
```typescript
/**
 * Convert audio buffer to WAV format for reliable upload to transcription services.
 * Some services can't decode Plaud's OGG files directly.
 */
export function convertToWav(audioBuffer: Buffer): Promise<Buffer>
```

- Example from `src/config.ts`:
```typescript
/** Load full config. Throws if required vars are missing. */
export function loadConfig()
```

**Inline comments:**
- Explain "why" not "what": `// Buffer uses a shared pool — .buffer may be 8KB. Slice to get a clean ArrayBuffer.`
- Quota/limit documentation: `// Limit Eagle processing to this many seconds per AssemblyAI speaker label.`
- Warn about side effects: `// export() returns ArrayBuffer backed by native memory. Must copy before profiler.release() frees it.`

## Function Design

**Size:** Functions are focused and typically 20-50 lines, longer functions (100+ lines) only when handling multi-step pipelines

**Parameters:**
- Rarely more than 3-4 parameters; use config objects for many options
- Named parameters with type annotations: `function processRecording(recording: PlaudRecording, plaudClient: PlaudClient, config: Config)`
- Single responsibility per function

**Return Values:**
- Explicit return types on all public functions: `Promise<string>`, `Map<string, string>`, `SpeakerProfiles`
- Functions return `null` to indicate absence (not undefined): `enrollSpeaker()` returns `ArrayBuffer | null`
- Promise-based async operations (no callbacks)

**Example from `src/speakers/profiles.ts`:**
```typescript
export function loadProfiles(dataDir: string): SpeakerProfiles {
  const path = join(dataDir, PROFILES_FILE);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function buildSpeakerMap(
  utteranceSpeakers: string[],
  recognizedSpeakers: Map<string, string> | null,
): Map<string, string> {
  const map = new Map<string, string>();
  // ...
  return map;
}
```

## Module Design

**Exports:**
- Named exports for all public functions and types
- No default exports
- Functions grouped logically in modules by domain: `transcription/`, `speakers/`, `notes/`, `cli/`

**Barrel Files:**
- Not used; each module explicitly imported where needed

**Module Responsibilities:**
- `src/config.ts` - Environment variable loading and validation
- `src/state.ts` - Persistent state (processed IDs, recording metadata, history)
- `src/log.ts` - Logging utilities
- `src/audio.ts` - Audio format conversion (ffmpeg wrappers)
- `src/pipeline.ts` - Orchestration of transcription → recognition → summarization → writing
- `src/plaud/client.ts` - Plaud API HTTP client with retry logic
- `src/plaud/types.ts` - Plaud API response types
- `src/transcription/assemblyai.ts` - AssemblyAI API integration
- `src/summarization/gemini.ts` - Gemini LLM API integration
- `src/speakers/eagle.ts` - Picovoice Eagle speaker recognition and enrollment
- `src/speakers/profiles.ts` - Speaker profile storage and retrieval
- `src/notes/vault.ts` - Obsidian vault folder scanning
- `src/notes/template.ts` - Note template loading and defaults
- `src/notes/writer.ts` - Markdown note generation and speaker label parsing
- `src/cli/*.ts` - CLI command implementations

---

*Convention analysis: 2026-04-16*
