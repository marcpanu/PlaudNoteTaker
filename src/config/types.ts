/**
 * Shared Config type produced by all loaders (CLI env-loader today; app-loader in Phase 2).
 * Fields, nullability, and defaults are preserved verbatim from the original src/config.ts
 * so existing pipeline/CLI behavior does not change.
 */
export interface Config {
  readonly plaudBearerToken: string;
  readonly assemblyAiApiKey: string;
  readonly geminiApiKey: string;
  readonly geminiModel: string;
  readonly picovoiceAccessKey: string;   // "" when not configured — preserves current falsy-check behavior
  readonly vaultPath: string;
  readonly vaultNotesFolder: string;
  readonly templatesPath: string;         // "" when not configured — preserves current falsy-check behavior
  readonly selectedTemplate: string;
  readonly pollInterval: number;          // milliseconds, already multiplied by 1000
  readonly dataDir: string;               // absolute path, already resolved
}
