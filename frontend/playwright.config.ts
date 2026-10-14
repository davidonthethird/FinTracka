import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:8788",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "FINTRACKA_E2E_PORT=8788 PYTHONPATH=../src ../.venv/bin/python ../e2e/server.py",
    url: "http://127.0.0.1:8788/api/v1/health",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
