/**
 * Validation helpers shared across loaders. Behavior preserved from original src/config.ts:
 * - required() throws with the exact same error message (CLI error output is part of the contract).
 * - optional() returns fallback only on falsy (undefined / empty string).
 */
export function required(raw: Record<string, string | undefined>, key: string): string {
  const value = raw[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}. Run 'plaud init' to set up.`);
  }
  return value;
}

export function optional(
  raw: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  return raw[key] || fallback;
}
