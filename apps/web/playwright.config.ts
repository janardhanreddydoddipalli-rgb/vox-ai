import { defineConfig } from "@playwright/test";

// E2E never calls a real (paid) model unless explicitly asked: Next would
// otherwise load GEMINI_API_KEY from .env.local. Only the manual real-model
// workflow sets E2E_REAL_MODEL=1.
const realModel = process.env.E2E_REAL_MODEL === "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://127.0.0.1:3010",
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "pnpm exec next dev -p 3010",
    url: "http://127.0.0.1:3010/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      E2E_TEST_AUTH: "1",
      ...process.env,
      GEMINI_API_KEY: realModel ? (process.env.GEMINI_API_KEY ?? "") : "",
    },
  },
});
