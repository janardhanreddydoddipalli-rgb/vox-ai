import { defineConfig } from "@playwright/test";

// The web app makes no model or database calls: it renders, signs in and mints
// API tokens. services/api must be running (API_INTERNAL_URL); the browser
// reaches it at NEXT_PUBLIC_API_URL, which defaults to the same URL here.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000";
const ci = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  timeout: 300_000,
  expect: { timeout: 30_000 },
  // Every spec signs in its own fresh users, so files can run side by side.
  workers: ci ? 2 : undefined,
  use: {
    baseURL: "http://127.0.0.1:3010",
    viewport: { width: 390, height: 844 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // CI serves the production build made in the same job (one server for every
    // worker); locally the dev server, reused if one is already running.
    command: ci ? "pnpm exec next start -p 3010" : "pnpm exec next dev -p 3010",
    url: "http://127.0.0.1:3010/signin",
    reuseExistingServer: !ci,
    timeout: 120_000,
    env: {
      E2E_TEST_AUTH: "1",
      ...process.env,
      API_INTERNAL_URL: process.env.API_INTERNAL_URL ?? apiUrl,
      NEXT_PUBLIC_API_URL: apiUrl,
    },
  },
});
