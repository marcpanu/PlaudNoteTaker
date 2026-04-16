# PlaudNoteTaker

A self-hosted pipeline that turns [Plaud](https://www.plaud.ai) voice recordings into structured Obsidian notes. Runs locally on your machine, writes markdown directly to your vault.

## What it does

```
Plaud Device (cloud) → Download → Transcribe + Diarize → Identify Speakers
                                                              ↓
   Obsidian Vault ← Write Note ← Pick Folder ← LLM Summary ←
```

1. **Polls** your Plaud account for new recordings every 60s
2. **Downloads** audio (OGG from Plaud, converted to WAV via ffmpeg)
3. **Transcribes** with [AssemblyAI](https://www.assemblyai.com) using `universal-3-pro` model with speaker diarization
4. **Identifies** known speakers using [Picovoice Eagle](https://picovoice.ai/platform/eagle/) voice recognition
5. **Summarizes** via [Google Gemini](https://ai.google.dev/) with a customizable prompt template
6. **Picks the right folder** — Gemini scans your vault's directory tree and chooses where the note belongs
7. **Writes** a markdown note to your Obsidian vault with title, attendees, summary, action items, and full transcript

Notes with unrecognized speakers get an "Unknown Speakers" callout at the top with a pre-filled command you can run to label them and enroll their voices for automatic recognition in future recordings.

## Why

Plaud's cloud AI is $20/month, requires trusting their servers with your audio, and won't integrate with your existing Obsidian knowledge base. This pipeline is ~$0.40/audio-hour (AssemblyAI) plus pennies for Gemini, writes directly to your vault, and you control everything.

## Prerequisites

- macOS or Linux
- Node.js 18+
- ffmpeg (`brew install ffmpeg`)
- A Plaud Note device with some recordings synced to your Plaud account
- API keys:
  - [Plaud](https://app.plaud.ai) bearer token (extracted from browser dev tools — `plaud init` walks you through it)
  - [AssemblyAI](https://www.assemblyai.com/dashboard) (required, paid — ~$0.37/audio-hour)
  - [Google Gemini](https://aistudio.google.com/apikey) (required, free tier available)
  - [Picovoice](https://console.picovoice.ai) (optional, for speaker recognition — free tier is 100 min/mo)

## Setup

```bash
git clone https://github.com/marcpanu/PlaudNoteTaker.git
cd PlaudNoteTaker
npm install
npx tsx src/index.ts init
```

The `init` command interactively collects all API keys, tests the Plaud connection, and writes your config to `.env`.

## Usage

```bash
# Start polling for new recordings
npx tsx src/index.ts start

# Validate your config without running the full pipeline
npx tsx src/index.ts test

# Label speakers in an existing note (after editing the Unknown Speakers section)
npx tsx src/index.ts label "/path/to/your/note.md"

# Manage enrolled speaker profiles
npx tsx src/index.ts speakers list
npx tsx src/index.ts speakers delete "Name"
```

### Speaker labeling workflow

When a recording has unrecognized speakers, the generated note includes a callout like:

```markdown
> **Unknown Speakers** — Fill in names and run the command below...
>
> - Speaker A:
> - Speaker B:
>
> ```
> npx tsx src/index.ts label "/Users/you/obsidian-vault/.../note.md"
> ```
```

Edit the note in Obsidian to fill in names (`Speaker A: Marc`), then run the command from your terminal. It:
1. Replaces `Speaker A` → `Marc` throughout the note
2. Removes the Unknown Speakers section
3. Downloads the original audio and enrolls each new speaker's voice with Picovoice
4. Future recordings with those speakers will be auto-labeled

## Smart folder routing

Every run, Gemini is given your vault's directory tree (excluding hidden folders and `.md` files) and asked to pick the best folder for the note based on content. A voicemail about dental insurance might go to `Health/Insurance`, a sprint planning meeting to `Work/Meetings`. Falls back to `VAULT_NOTES_FOLDER` from `.env` if Gemini doesn't return a valid folder.

## Configuration

All config lives in `.env` — see `.env.example` for the full list. Key options:

- `VAULT_PATH` — absolute path to your Obsidian vault root
- `VAULT_NOTES_FOLDER` — fallback subfolder when smart routing fails
- `TEMPLATES_PATH` — custom prompt templates (falls back to built-in)
- `SELECTED_TEMPLATE` — template filename (without `.md`)
- `GEMINI_MODEL` — defaults to `gemini-2.5-flash`
- `POLL_INTERVAL` — seconds between Plaud polls (default 60)

## Architecture notes

### Why two services for speaker handling?

- **AssemblyAI diarization** tells you *that* there are N distinct speakers in a recording, labeled A, B, C...
- **Picovoice Eagle** identifies *who* those speakers are by matching against enrolled voice profiles

AssemblyAI has a feature called "Speaker Identification" but it doesn't support voice enrollment — it only re-labels diarized speakers using in-file cues (like someone saying "Hi, I'm Marc") plus a list of names you pass in per request. It has no memory across files. Picovoice Eagle is the state of the art for on-device voice enrollment and cross-session identification.

### Picovoice quota management

Picovoice's free tier caps Eagle at 100 minutes of audio processing per month. To stretch this, the pipeline only runs Eagle on the first 30 seconds of audio per speaker (enough to reliably identify a voice). A 1-hour meeting with 3 speakers uses ~1.5 minutes of Eagle quota instead of 60 minutes.

Picovoice does not offer a paid tier for personal use — commercial plans are sales-gated and gmail addresses are rejected. If you exceed the free quota, speaker recognition fails gracefully and the note is still saved with `Speaker A/B/C` labels; you can label them via the `label` command afterward.

## Project structure

```
src/
├── config.ts              # Env loader with validation
├── index.ts               # CLI router
├── pipeline.ts            # Per-recording pipeline
├── audio.ts               # ffmpeg WAV conversion + PCM decoding
├── state.ts               # Processed IDs, recording metadata, history
├── log.ts                 # Timestamped logging
├── plaud/
│   ├── client.ts          # PlaudClient with retry/rate-limit handling
│   └── types.ts           # Plaud API response types
├── transcription/
│   └── assemblyai.ts      # Upload, submit w/ diarization, poll
├── summarization/
│   └── gemini.ts          # Gemini API call with folder-routing prompt
├── speakers/
│   ├── eagle.ts           # Enrollment + recognition with quota conservation
│   └── profiles.ts        # Speaker profile storage
├── notes/
│   ├── template.ts        # Load templates with built-in default
│   ├── vault.ts           # Scan vault folder tree for smart routing
│   └── writer.ts          # Build markdown, parse/apply speaker labels
└── cli/
    ├── init.ts            # Interactive setup
    ├── test.ts            # Config + connection validation
    ├── start.ts           # Polling loop
    ├── label.ts           # Speaker labeling + enrollment
    └── speakers.ts        # Profile management
```

## Acknowledgments

Built from two foundations:
- [openplaud/openplaud](https://github.com/openplaud/openplaud) — inspired the PlaudClient (bearer token auth, retry logic)
- A personal Obsidian plugin that served as the original proof-of-concept for the AssemblyAI + Eagle + Gemini pipeline

## License

MIT
