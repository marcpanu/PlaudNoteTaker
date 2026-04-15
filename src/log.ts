const startTime = Date.now();

function timestamp(): string {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const now = new Date().toLocaleTimeString("en-US", { hour12: false });
  return `[${now} +${elapsed}s]`;
}

export function log(...args: unknown[]): void {
  console.log(timestamp(), ...args);
}

export function warn(...args: unknown[]): void {
  console.warn(timestamp(), ...args);
}

export function error(...args: unknown[]): void {
  console.error(timestamp(), ...args);
}
