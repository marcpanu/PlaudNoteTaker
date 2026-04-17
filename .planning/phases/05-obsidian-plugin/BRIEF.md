# Phase 5 Execution Brief — Unified Obsidian Plugin

## Origin & scope change from original roadmap

**Original Phase 5** (per ROADMAP.md): build a standalone Obsidian plugin with just a "Match Speakers" button for notes with an Unknown Speakers callout. 7 requirements (PLUG-01..07).

**Revised Phase 5** (this brief): copy the user's existing `obsidian-note-taker` plugin (in-Obsidian recording + transcription) into this repo as `obsidian-plugin/`, strip `@picovoice/eagle-web`, and route all Eagle operations (enroll, recognize, label) through the daemon's HTTP bridge so the whole system uses a single SDK and a single profile store. Adds the "Match Speakers" button as a subset of the larger unification.

Rationale (empirically verified in `scripts/test-cross-sdk-profile.ts`): eagle-web and eagle-node profile byte formats are incompatible. The node SDK produces NaN scores when handed a web-SDK profile. Unifying the speaker profile store requires unifying the SDK — which means Eagle lives only in the daemon; the plugin delegates.

## End state

```
PlaudNoteTaker/
├── src/                        ← existing pipeline (CLI + Electron)
├── electron/                   ← existing Electron app
├── obsidian-plugin/            ← NEW: copied from obsidian-note-taker/
│   ├── main.ts                 ← modified: no eagle-web, bridge client
│   ├── bridge-client.ts        ← NEW: typed wrapper around /speakers/* + /config/api-keys
│   ├── manifest.json
│   ├── esbuild.config.mjs
│   └── ...
├── scripts/
│   └── test-cross-sdk-profile.ts
└── ...
```

The user's existing `/Users/marcpanu/CodeRepos/obsidian-note-taker/` is NOT modified (per user directive). The copy is one-way; future plugin work happens in `PlaudNoteTaker/obsidian-plugin/`.

## Architecture after Phase 5

```
┌─────────────────┐         ┌──────────────────────┐
│  Obsidian       │  HTTP   │  PlaudNoteTaker       │
│  plugin         ├────────►│  daemon (Electron)    │
│                 │loopback │                       │
│  • MediaRec     │         │  • src/speakers/      │
│  • AssemblyAI   │         │    eagle.ts (NODE)    │
│  • Gemini       │         │  • speaker-profiles   │
│  • templates    │         │    .json (single store)│
│  • Match btn    │         │  • bridge Hono server │
└─────────────────┘         └──────────────────────┘
       │                              │
       └──────── same bytes on disk ──┘
                (profile JSON,
                 both read via node-SDK eagle)
```

Key invariant: **only the daemon calls `@picovoice/eagle-node`.** The plugin doesn't import any Picovoice package at all.

## Bridge extensions needed

Today's bridge has `/health` + `/label-speakers`. Add:

```
GET  /config/api-keys              → { plaud, assemblyai, gemini, picovoice }
                                     (for plugin to use AssemblyAI + Gemini directly;
                                      picovoice key NOT actually used by plugin but
                                      returned for completeness / debugging)

GET  /speakers                     → [{ name }, ...]
DELETE /speakers/:name             → { ok: true }

POST /speakers/enroll              → { ok, enrolled, feedback? }
     body: { name: string, pcm_base64: string, sampleRate: 16000 }

POST /speakers/recognize           → { labels: [{ speaker: string, name: string | null }] }
     body: {
       pcm_base64: string,
       sampleRate: 16000,
       utterances: [{ speaker: string, start: number, end: number, text: string }]
     }

POST /label-speakers               (existing from Phase 4 — already writes notes)
```

All endpoints require the Bearer token from `bridge.json`.

## Work breakdown

### Plan 05-01: Bridge extensions (daemon side)
**Owner:** single agent or inline

**Files:**
- `electron/app/bridge.ts` — add 4 new endpoints
- `src/speakers/eagle.ts` — refactor: expose `enrollFromPcm(pcm, accessKey)` as standalone async wrapper (currently only callable from the label CLI flow)
- `src/speakers/profiles.ts` — add atomic write (temp file + rename) to prevent torn writes when plugin-triggered enrollment fires alongside daemon polling
- `electron/app/service.ts` — add `enrollSpeakerFromPcm(name, pcmBase64)` method that delegates to `src/speakers/eagle.ts` under the reentrancy lock

**Tasks:**
1. `GET /config/api-keys` — reads from current loaded config, returns non-null values only
2. `GET /speakers` — reads `speaker-profiles.json`, returns names
3. `DELETE /speakers/:name` — removes entry, atomic-writes updated file
4. `POST /speakers/enroll` — decodes base64 PCM to Int16Array, calls `service.enrollSpeakerFromPcm`, returns progress
5. `POST /speakers/recognize` — decodes PCM, calls `recognizeSpeakers` from `src/speakers/eagle.ts` with current enrolled profiles
6. Commit with clear tests showing all 4 endpoints round-trip

**Verification (curl from bash):**
```bash
BASE=$(cat "$HOME/Library/Application Support/Plaud Obsidian Note Taker/bridge.json" | jq -r '"http://127.0.0.1:\(.port)"')
TOKEN=$(cat "$HOME/Library/Application Support/Plaud Obsidian Note Taker/bridge.json" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/speakers"
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/config/api-keys"
```

### Plan 05-02: Plugin copy + bridge client + de-Eagle-ization
**Owner:** single agent

**Setup:**
1. `cp -r /Users/marcpanu/CodeRepos/obsidian-note-taker obsidian-plugin` (then `rm -rf node_modules`)
2. Add `obsidian-plugin/` to repo's `.gitignore` for `node_modules` + build artifacts
3. Update `obsidian-plugin/package.json`:
   - Remove `@picovoice/eagle-web` dep
   - Remove `@picovoice/web-voice-processor` dep (used only for Eagle)
   - Keep esbuild, TypeScript, obsidian types
4. Delete `obsidian-plugin/eagle-speaker.ts` entirely

**New file: `obsidian-plugin/bridge-client.ts`** — typed HTTP client that reads `bridge.json`, does Authorization header, wraps the 5 endpoints. Uses Obsidian's `requestUrl` (not `fetch`, per CORS requirements).

```ts
// Signature sketch:
export interface BridgeClient {
  getApiKeys(): Promise<ApiKeys | null>;
  listSpeakers(): Promise<string[]>;
  deleteSpeaker(name: string): Promise<void>;
  enrollSpeaker(name: string, pcm: Int16Array): Promise<{ ok: boolean; feedback?: number }>;
  recognizeSpeakers(pcm: Int16Array, utterances: Utterance[]): Promise<Record<string, string>>;
  labelSpeakers(notePath: string): Promise<{ matched: number; enrolled: number }>;
  health(): Promise<{ ok: boolean; version: string } | null>;
}
```

**Plugin wiring changes (in `main.ts`):**
1. **On load:** try `bridgeClient.getApiKeys()`. If success, cache in memory + persist to plugin settings as fallback. If fail, fall back to plugin settings values.
2. **Replace all `EagleSpeakerManager` usage:**
   - Enrollment modal → calls `bridgeClient.enrollSpeaker(name, pcm)`
   - Post-recording speaker recognition → calls `bridgeClient.recognizeSpeakers(pcm, utterances)`
   - Speaker list (settings tab + sidebar panel) → calls `bridgeClient.listSpeakers()`
   - Delete → calls `bridgeClient.deleteSpeaker(name)`
3. **Remove `speakerProfiles` from plugin settings schema.** Profiles live only in the daemon.
4. **Graceful degradation when daemon is down:**
   - Transcription still works (AssemblyAI calls are independent)
   - Summarization still works
   - Recognition/enrollment surfaces a Notice: "PlaudNoteTaker daemon not running — speakers won't be matched this session"

**Verification:**
- Record a note in Obsidian with the daemon running → note is inserted with speaker labels
- Daemon restarts, plugin keeps working from cached keys
- Daemon off → recording works, but speaker section shows unmatched labels with a Notice

### Plan 05-03: Match Speakers button
**Owner:** single agent

**Files:**
- `obsidian-plugin/match-speakers.ts` — new; markdown post-processor that detects the Unknown Speakers callout and renders the button
- `obsidian-plugin/main.ts` — register the post-processor on load

**Behavior:**
- `registerMarkdownPostProcessor` detects the callout pattern `> **Unknown Speakers**` at the top of a note
- Injects a button inline: "Match Speakers"
- On click: POSTs `bridgeClient.labelSpeakers(notePath)`. The daemon's existing `/label-speakers` (from Phase 4) does the labeling + enrollment work.
- Button shows tri-state: idle → spinner → check/error message
- After success: button disappears on re-render (callout gone from note)

**Idempotence:** use `MarkdownRenderChild` subclass so the button cleans up on re-render; never injected twice.

**Graceful fallback:** if daemon unreachable, button shows "PlaudNoteTaker not running" inline.

## Resolved decisions

1. **Speaker re-enrollment**: drop. User (Marc) is already enrolled daemon-side; existing plugin-side "Marc" profile is deleted silently. No migration flow needed.
2. **Plugin transcription/summarization**: keep working independently. Bridge-fetched keys are primary; plugin settings cache is fallback. Plugin stays transcription-capable when daemon is down — only Eagle features degrade.
3. **Dev iteration**: build script compiles via esbuild then `cp`s `main.js` + `manifest.json` into `~/obsidian-vault/.obsidian/plugins/ai-notetaker/`. User reloads the plugin in Obsidian. No symlink. `data.json` in the target dir is not touched so plugin settings survive rebuilds.

## What stays the same

- Electron daemon (Phase 2-4 work) — no changes required
- Original Phase 5 requirements (PLUG-01..07) — satisfied by this broader work
- CLI still runs (nothing touched in `src/cli/`)

## Estimated time

- Plan 05-01 (bridge extensions): 45 min
- Plan 05-02 (plugin copy + bridge client + remove eagle-web): 60–90 min
- Plan 05-03 (match button): 30 min
- Integration + smoke test with actual recording: 30 min

**Total: ~3 hours** for a clean end-to-end integrated plugin.
