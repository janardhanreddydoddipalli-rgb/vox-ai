import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:3010",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "npx next dev -p 3010",
    url: "http://127.0.0.1:3010/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_TEST_AUTH: "1",
      ...process.env,
    },
  },
});
