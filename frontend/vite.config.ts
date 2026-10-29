import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const runtime = globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } };

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": runtime.process?.env?.FINTRACKA_API_TARGET || "http://127.0.0.1:8787" },
  },
  test: { environment: "node", include: ["tests/**/*.test.{ts,tsx}"] },
});
