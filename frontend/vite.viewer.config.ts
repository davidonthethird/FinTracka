import { renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "fintracka-viewer-index",
      closeBundle() {
        renameSync(
          resolve(import.meta.dirname, "dist-viewer/viewer.html"),
          resolve(import.meta.dirname, "dist-viewer/index.html"),
        );
      },
    },
  ],
  build: {
    outDir: "dist-viewer",
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "viewer.html") },
  },
});
