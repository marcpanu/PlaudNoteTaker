# Testing Patterns

**Analysis Date:** 2026-04-16

## Test Framework

**Status:** No automated testing framework configured

**Current Situation:**
- No Jest, Vitest, Mocha, or other test runner configured
- No test files (*.test.ts, *.spec.ts) in `src/` directory
- Only dev dependency is TypeScript and tsx runtime
- Manual testing via CLI commands: `npm run dev`, `tsx src/index.ts`

## Test Commands

**Manual Testing:**
```bash
npm run dev                      # Run CLI in development mode
tsx src/index.ts init           # Test init command
tsx src/index.ts test           # Test config and API connections (see src/cli/test.ts)
tsx src/index.ts start          # Test polling loop
tsx src/index.ts label <file>   # Test speaker labeling
```

## Recommended Test Setup (Not Yet Implemented)

If testing is added, these patterns would be appropriate:

**Testing Framework:**
- Vitest recommended (faster, ESM-native, lower config)
- Alternative: Jest with ESM configuration

**Test File Organization:**
- Co-located with source: `src/config.test.ts` next to `src/config.ts`
- CLI tests: `src/cli/start.test.ts`
- Utilities: `src/__tests__/fixtures.ts` for test data

## Testing Approaches Observed

**Manual Integration Tests:**
- `src/cli/test.ts` is a manual verification command that tests API connections
  - Tests Plaud API connectivity
  - Validates AssemblyAI API key
  - Validates Gemini API key
  - Checks Picovoice configuration
  - No automated runner; user invokes via `plaud test`

**Error Path Testing:**
- Errors are tested manually by triggering scenarios:
  - Empty audio: AssemblyAI returns "no spoken audio" error, handled in `src/cli/start.ts` line 86
  - Network failures: Retry logic tested via manual rate-limiting (see `src/plaud/client.ts` lines 39-78)
  - Missing config: Throws on `loadConfig()` if env vars missing (see `src/config.ts`)

## Code That Would Benefit From Testing

**High Priority (core logic):**
- `src/speakers/eagle.ts` - Speaker recognition and enrollment logic
  - `recognizeSpeakers()` - Complex scoring and matching algorithm
  - `assignSpeakers()` - Candidate ranking and deduplication
  - `enrollSpeaker()` - Frame-based enrollment progress
  - `profileFromBase64()` / `profileToBase64()` - Buffer/ArrayBuffer conversion

- `src/notes/writer.ts` - Note generation and parsing
  - `parseUnknownSpeakers()` - Regex-based speaker label extraction
  - `applyLabels()` - Text replacement and section removal
  - `buildTranscriptText()` - Speaker name resolution

- `src/plaud/client.ts` - API client retry logic
  - Retry backoff calculation
  - Rate limit handling (429 status)
  - Server error detection and retry

**Medium Priority (data transformation):**
- `src/summarization/gemini.ts` - Prompt building and response parsing
  - `summarizeTranscript()` - Template variable substitution
  - `parseSummaryOutput()` - FOLDER line extraction

- `src/transcription/assemblyai.ts` - Transcription request/response handling
  - Poll loop termination conditions
  - Error classification (retryable vs. fatal)

- `src/state.ts` - Persistence layer
  - JSON serialization/deserialization
  - History filtering by date range

**Lower Priority (CLI/UX):**
- `src/cli/init.ts` - Interactive setup (harder to test)
- `src/cli/start.ts` - Polling loop (requires mocking)

## Test Patterns (If Implemented)

**Unit Test Structure:**
```typescript
import { describe, it, expect } from "vitest";
import { parseUnknownSpeakers, applyLabels } from "../notes/writer.ts";
import { writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("parseUnknownSpeakers", () => {
  it("extracts speaker labels from blockquote format", () => {
    const content = `> - Speaker A: Marc
> - Speaker B: Sarah Chen
> \`\`\`
> npx tsx src/index.ts label "file.md"
> \`\`\``;
    
    const filePath = join(tmpdir(), "test.md");
    writeFileSync(filePath, content);
    
    const labels = parseUnknownSpeakers(filePath);
    expect(labels.get("A")).toBe("Marc");
    expect(labels.get("B")).toBe("Sarah Chen");
  });

  it("ignores empty speaker names", () => {
    const content = `> - Speaker A:
> - Speaker B: John`;
    
    const filePath = join(tmpdir(), "test.md");
    writeFileSync(filePath, content);
    
    const labels = parseUnknownSpeakers(filePath);
    expect(labels.has("A")).toBe(false);
    expect(labels.get("B")).toBe("John");
  });
});
```

**Mocking Pattern (External Services):**
```typescript
import { describe, it, expect, vi } from "vitest";
import { transcribeAudio } from "../transcription/assemblyai.ts";

describe("transcribeAudio", () => {
  it("retries on internal server error", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("Internal server error"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ upload_url: "https://..." }),
      });
    
    global.fetch = mockFetch;
    
    // Test retry behavior
    const buffer = Buffer.from("audio");
    await expect(transcribeAudio(buffer, "key")).rejects.toThrow();
  });
});
```

**Fixture Pattern (Test Data):**
Location: `src/__tests__/fixtures.ts`

```typescript
export const mockUtterances = [
  {
    speaker: "A",
    text: "Hello everyone, let's start the meeting.",
    start: 0,
    end: 3000,
  },
  {
    speaker: "B",
    text: "Sounds good, what's on the agenda?",
    start: 3500,
    end: 5000,
  },
];

export const mockSpeakerMap = new Map([
  ["A", "Marc"],
  ["B", "Sarah"],
]);

export const mockRecordingMeta = {
  recordingId: "rec_123",
  utterances: mockUtterances,
};
```

## Coverage Goals (Not Yet Implemented)

If tests are added:
- **Target:** 70%+ for core modules (speakers, notes, state)
- **Exclude:** CLI commands (hard to test interactively), API clients (require mocking)
- **Focus:** Data transformation functions, parsing, error handling

## Manual Testing Checklist

Since no automated tests exist, use this for verification:

**Transcription Pipeline:**
- [ ] `plaud test` - Verify all API keys configured
- [ ] `plaud start` - Run once, verify note created with correct structure
- [ ] Empty audio recording - Verify "no spoken audio" error is handled gracefully
- [ ] Vault folder selection - Verify note lands in correct folder or default

**Speaker Recognition:**
- [ ] Enroll speaker: `plaud label <note>` - Verify voice profile saved
- [ ] Re-run pipeline - Verify speaker name appears in subsequent notes
- [ ] Delete profile: `plaud speakers delete <name>` - Verify removal from list

**Note Generation:**
- [ ] Verify markdown structure (heading, date, unknown speakers section, transcript)
- [ ] Unknown speakers: Verify label syntax `> - Speaker A: ` can be filled in
- [ ] Apply labels: Verify speaker names replace labels throughout note
- [ ] Verify unknown section removed when all speakers labeled

**Configuration:**
- [ ] `plaud init` - Verify all prompts work, .env created correctly
- [ ] Missing var - Verify helpful error message on `loadConfig()` error
- [ ] Environment overrides - Verify POLL_INTERVAL, VAULT_NOTES_FOLDER can be customized

---

*Testing analysis: 2026-04-16*
