import { copyFileSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  publicDir: command === "build" ? false : "public",
  resolve: {
    alias: { "onnxruntime-web": "onnxruntime-web/wasm" },
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
  plugins: [
    react(),
    {
      name: "fintracka-receipt-ocr-runtime",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const match = request.url?.match(/^\/receipt-ocr\/ort\/(ort-wasm-[a-z.-]+\.mjs)(?:\?.*)?$/);
          if (!match) { next(); return; }
          response.setHeader("Content-Type", "text/javascript");
          response.end(readFileSync(resolve(import.meta.dirname, "public", "receipt-ocr", "ort", match[1])));
        });
      },
    },
    {
      name: "fintracka-viewer-index",
      closeBundle() {
        renameSync(
          resolve(import.meta.dirname, "dist-viewer/viewer.html"),
          resolve(import.meta.dirname, "dist-viewer/index.html"),
        );
        copyFileSync(resolve(import.meta.dirname, "public/favicon.svg"),
          resolve(import.meta.dirname, "dist-viewer/favicon.svg"));
      },
    },
  ],
  build: {
    outDir: "dist-viewer",
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, "viewer.html") },
  },
}));
