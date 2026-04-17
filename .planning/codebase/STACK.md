# Technology Stack

**Analysis Date:** 2026-04-16

## Languages

**Primary:**
- TypeScript 6.0.2 - All source code; strict mode enabled

**Secondary:**
- JavaScript (Node.js) - Runtime execution after compilation

## Runtime

**Environment:**
- Node.js 16+ (module resolution: Node16)

**Package Manager:**
- npm
- Lockfile: Present (`package-lock.json`)

## Frameworks

**Core:**
- None (vanilla TypeScript/Node.js CLI application)

**Runtime Processing:**
- @picovoice/eagle-node 3.0.0 - Speaker recognition/diarization from pre-recorded audio
- dotenv 17.4.2 - Environment variable loading from `.env`

**Build/Dev:**
- TypeScript 6.0.2 - Compilation target: ES2022, module system: Node16
- tsx 4.21.0 - TypeScript execution for local development
- @types/node 25.6.0 - Node.js type definitions

## Key Dependencies

**Critical:**
- @picovoice/eagle-node 3.0.0 - Only direct runtime dependency; handles speaker recognition using native bindings

**Infrastructure:**
- dotenv 17.4.2 - Configuration management from `.env` file
- Node.js built-in modules: fs, path, child_process, crypto, os (no external polyfills)

## Configuration

**Environment:**
- Configuration loaded via dotenv from `.env` file in project root
- File: `src/config.ts` - Enforces required and optional environment variables
- Fallback values for non-critical settings (poll interval, data directory)

**Build:**
- TypeScript configuration: `tsconfig.json`
  - Target: ES2022
  - Module resolution: Node16 (ESM)
  - Strict mode enabled
  - Source maps generated
  - Type declarations generated

**Entry Points:**
- CLI binary: `dist/index.js` (compiled from `src/index.ts`)
- Executable via npm scripts: `npm run start` or `npm run dev`
- Can be installed globally as `plaud` command

## Platform Requirements

**Development:**
- Node.js 16+ 
- npm (or compatible package manager)
- FFmpeg - Required for audio format conversion (invoked via `execFile` in `src/audio.ts`)
- macOS, Linux, or Windows (Node.js platform-agnostic; FFmpeg required system-wide)

**Production:**
- Node.js 16+ runtime
- FFmpeg - Required for audio conversion operations
- File system access - For local data storage (`./data` directory by default)
- Network access - For external API calls (Plaud, AssemblyAI, Gemini, Picovoice)

## Language Features

**JavaScript/TypeScript Features Used:**
- ES Modules (type: "module" in package.json)
- Async/await for API calls and file operations
- Fetch API for HTTP requests (native to Node.js 18+)
- Buffer API for audio handling
- Child process spawning via execFile (FFmpeg integration)
- Map/Set for speaker tracking
- ReadableStream not used; direct Buffer operations instead

## Notable Absence

- No web framework (Express, Fastify, etc.) - CLI-only application
- No database library (Prisma, TypeORM, etc.) - Uses JSON file-based state storage
- No testing framework - No test dependencies or test files present
- No linting/formatting tools - No ESLint or Prettier config files
- No bundler - TypeScript compiles directly to CommonJS/ESM

---

*Stack analysis: 2026-04-16*
