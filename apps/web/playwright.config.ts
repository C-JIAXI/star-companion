import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // All projects share the app's local SQLite database during E2E runs.
  workers: 2,
  timeout: 45_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "node ../../scripts/e2e/start-server.mjs",
      url: "http://127.0.0.1:4010/api/health",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "node ../../scripts/e2e/start-web.mjs",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      timeout: 120_000
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] }
    }
  ]
});
