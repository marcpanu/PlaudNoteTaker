# AI Notetaker for Obsidian

Record meetings directly in Obsidian and get AI-generated structured notes with speaker identification.

## Features

- **Audio Recording** — Record meetings with a single click from the ribbon icon or sidebar panel
- **Transcription with Speaker Diarization** — Automatic transcription via AssemblyAI with speaker labels (Speaker A, Speaker B, etc.)
- **AI-Generated Meeting Notes** — Uses Google Gemini to produce structured notes with a contextual title, attendee list, summary, and action items
- **Cross-Session Speaker Recognition** — Enroll speakers using Picovoice Eagle so their names are automatically recognized in future meetings
- **Custom Prompt Templates** — Create your own Gemini prompt templates as markdown files in your vault
- **Raw Transcript** — Full transcript is always appended separately (not processed through Gemini) to save tokens

## Setup

1. Install the plugin
2. Configure API keys in Settings > AI Notetaker:
   - **AssemblyAI API Key** (required) — Get one at [assemblyai.com](https://www.assemblyai.com)
   - **Gemini API Key** (optional) — For AI-generated notes. Get one at [aistudio.google.com](https://aistudio.google.com/apikey)
   - **Picovoice AccessKey** (optional) — For speaker recognition. Free at [console.picovoice.ai](https://console.picovoice.ai/)

## Usage

### Recording a Meeting

1. Click the microphone icon in the ribbon (left sidebar) to start recording
2. Click the stop icon to end recording
3. The plugin will transcribe the audio and insert structured notes at your cursor position

### Speaker Recognition

After your first recording, use the **Label Speakers in Note** command to:
- Name each speaker (e.g., "Speaker A" becomes "Alice")
- Optionally enroll speakers for automatic recognition in future meetings

Enrolled speakers are automatically identified in subsequent recordings.

### Managing Speakers

- Use the **Manage Speaker Profiles** command to view or remove enrolled speakers
- The sidebar panel shows all enrolled speakers and recording controls

### Custom Templates

1. Create a folder in your vault for templates (e.g., `Templates/AI Notetaker Templates`)
2. Select the folder in Settings > AI Notetaker > Template Folder
3. Add `.md` files with your custom prompts — use `{{transcript}}` as a placeholder for the transcript
4. Select your template from the dropdown in settings

The default template produces: a contextual meeting title, attendee list, summary with key points, and action items with owners.

## Commands

| Command | Description |
|---------|-------------|
| Start/Stop Recording | Toggle audio recording |
| Label Speakers in Note | Name speakers and enroll for future recognition |
| Manage Speaker Profiles | View and remove enrolled speaker profiles |

## Requirements

- Desktop only (uses microphone access)
- AssemblyAI API key (required for transcription)
- Gemini API key (optional, for AI-generated notes)
- Picovoice AccessKey (optional, for speaker recognition)

## License

[MIT](LICENSE)
