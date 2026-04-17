import { resolve } from "node:path";

const APP_NAME = "Plaud Obsidian Note Taker";
const BUNDLE_ID = "com.marcpanu.plaudobsidiannotetaker";

// Resolve ffmpeg-static binary path at build time so Forge bundles it into Resources/.
// At runtime: app.isPackaged → process.resourcesPath/ffmpeg; dev → require('ffmpeg-static').
const ffmpegBinary = resolve("node_modules/ffmpeg-static/ffmpeg");

// @picovoice/eagle-node is a native Node-API module. The Forge Vite plugin packs only
// the Vite build output into app.asar and does NOT copy node_modules, so we must ship
// the eagle-node package tree explicitly as an extra resource. Runtime loads it via
// createRequire pointed at process.resourcesPath/eagle-node/node_modules/@picovoice/eagle-node.
const eagleNodeDir = resolve("node_modules/@picovoice/eagle-node");

export default {
  packagerConfig: {
    name: APP_NAME,
    appBundleId: BUNDLE_ID,
    appCategoryType: "public.app-category.productivity",
    // Menubar-only: no Dock icon. LSUIElement=true is the authoritative switch.
    extendInfo: {
      LSUIElement: true,
      CFBundleDisplayName: APP_NAME,
      // Groups notifications in Notification Center under this identifier.
      CFBundleIdentifier: BUNDLE_ID,
    },
    extraResource: [
      ffmpegBinary,
      eagleNodeDir,
      resolve("electron/assets/iconTemplate.png"),
      resolve("electron/assets/iconTemplate@2x.png"),
    ],
    // ffmpeg must live outside asar so child_process can exec it.
    asar: {
      unpack: "**/ffmpeg",
    },
    // Signing/notarization wired in Phase 2b. Unsigned builds for 2a.
    osxSign: undefined,
    osxNotarize: undefined,
  },
  rebuildConfig: {
    // @picovoice/eagle-node 3.0 ships prebuilt Node-API binaries and does not need rebuild.
    // Keep rebuild available as a safety net but skip eagle-node to avoid clobbering prebuilds.
    onlyModules: [],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    // maker-dmg wired in Phase 2b after signing is in place.
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          {
            entry: "electron/main.ts",
            config: "electron/vite.main.config.ts",
            target: "main",
          },
          {
            entry: "electron/preload.ts",
            config: "electron/vite.preload.config.ts",
            target: "preload",
          },
        ],
        // Agent B (Phase 3 renderer): Settings + Logs windows via shared multi-page Vite config.
        renderer: [
          {
            name: "settings",
            config: "electron/vite.renderer.config.ts",
          },
          {
            name: "logs",
            config: "electron/vite.renderer.config.ts",
          },
          {
            name: "popover",
            config: "electron/vite.renderer.config.ts",
          },
        ],
      },
    },
  ],
  hooks: {
    // Phase 2b will add a postPackage hook here to individually codesign
    // the bundled ffmpeg binary with --options=runtime before the outer .app is signed.
  },
};
