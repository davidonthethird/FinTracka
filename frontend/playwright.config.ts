import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:18788",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "FINTRACKA_E2E_PORT=18787 PYTHONPATH=../src python ../e2e/server.py",
      url: "http://127.0.0.1:18787/api/v1/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "FINTRACKA_API_TARGET=http://127.0.0.1:18787 npm run dev -- --host 127.0.0.1 --port 18788",
      url: "http://127.0.0.1:18788",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "npm run build:viewer && FINTRACKA_VIEWER_E2E_PORT=18789 node e2e/remote-viewer-server.ts",
      url: "http://127.0.0.1:18789/api/v1/status",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
