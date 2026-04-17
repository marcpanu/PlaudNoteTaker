import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "electron/main.ts",
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      external: [
        "electron",
        "@picovoice/eagle-node",
        "ffmpeg-static",
        "dotenv",
        // Node built-ins
        "node:fs",
        "node:path",
        "node:module",
        "node:child_process",
        "node:os",
        "node:crypto",
        "node:url",
        "fs",
        "path",
        "child_process",
        "os",
        "crypto",
        "url",
        "module",
      ],
    },
    outDir: ".vite/build",
    emptyOutDir: false,
    minify: false,
    sourcemap: "inline",
  },
});
