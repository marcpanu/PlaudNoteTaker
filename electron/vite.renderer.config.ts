import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Vite config for renderer processes — Settings and Logs windows.
 *
 * Multi-page build: both HTML files are listed as rollup input entries.
 * The @electron-forge/plugin-vite plugin will serve these in dev mode
 * and bundle them for production.
 */
export default defineConfig({
  root: resolve(__dirname, "renderer"),
  build: {
    outDir: resolve(__dirname, "../.vite/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve(__dirname, "renderer/settings/index.html"),
        logs: resolve(__dirname, "renderer/logs/index.html"),
        popover: resolve(__dirname, "renderer/popover/index.html"),
      },
    },
    minify: false,
    sourcemap: "inline",
  },
});
