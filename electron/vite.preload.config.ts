import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "electron/preload.ts",
      // ESM output. Root package.json has "type": "module", so Node loads
      // .js files as ESM. Electron 28+ supports ESM preload scripts natively.
      // Emitting CJS here produces a `require(...)` call that ESM Node rejects.
      formats: ["es"],
      fileName: () => "preload.js",
    },
    rollupOptions: {
      external: ["electron"],
    },
    outDir: ".vite/build",
    emptyOutDir: false,
    minify: false,
    sourcemap: "inline",
  },
});
