import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "electron/preload.ts",
      formats: ["cjs"],
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
