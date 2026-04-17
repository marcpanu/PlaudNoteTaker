/**
 * Canonical path resolution for the Electron app.
 * One place to resolve all filesystem locations; no other module should call app.getPath() directly.
 */

import { app } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type IconState = "idle" | "error";

/** All core app paths derived from userData. Call ensureDirs() at startup. */
export interface AppPaths {
  userDataDir: string;
  dataDir: string;
  settingsJsonPath: string;
  secretsJsonPath: string;
  migrationSentinelPath: string;
  pidfilePath: string;
}

let _paths: AppPaths | null = null;

/** Resolve all paths. Must be called after app.whenReady(). */
export function getPaths(): AppPaths {
  if (_paths) return _paths;

  const userDataDir = app.getPath("userData");
  _paths = {
    userDataDir,
    dataDir: join(userDataDir, "data"),
    settingsJsonPath: join(userDataDir, "settings.json"),
    secretsJsonPath: join(userDataDir, "secrets.json"),
    migrationSentinelPath: join(userDataDir, ".migration-complete"),
    pidfilePath: join(userDataDir, "data", "plaud.lock"),
  };
  return _paths;
}

/** Ensure userDataDir and dataDir exist. */
export function ensureDirs(): void {
  const { userDataDir, dataDir } = getPaths();
  for (const dir of [userDataDir, dataDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/** Path to the ffmpeg binary: packaged → resourcesPath/ffmpeg; dev → ffmpeg-static. */
export function ffmpegPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "ffmpeg");
  }
  return require("ffmpeg-static") as string;
}

/** Path to the tray icon based on state. */
export function trayIconPath(opts?: { state?: IconState }): string {
  const state = opts?.state ?? "idle";
  const iconFile = state === "error" ? "iconTemplate-error.png" : "iconTemplate.png";

  if (app.isPackaged) {
    return join(process.resourcesPath, iconFile);
  }

  // Dev: search from cwd or relative to this file
  const candidates = [
    resolve(process.cwd(), "electron/assets", iconFile),
    resolve(__dirname, "../../electron/assets", iconFile),
    // Fallback to idle icon if error icon doesn't exist
    resolve(process.cwd(), "electron/assets/iconTemplate.png"),
    resolve(__dirname, "../../electron/assets/iconTemplate.png"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}
