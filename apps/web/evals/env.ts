// Eval environment: must run before any app import (mirrors tests/setup.ts).
// Loads .env.local, forces the dedicated test database, and requires a real
// GEMINI_API_KEY — the eval exercises the live model, not a mock.
import { existsSync, readFileSync } from "node:fs";

// Minimal .env.local loader (KEY=VALUE lines) so `npm run eval` works without
// dotenv locally. Optional: in CI the values come from process.env (secrets),
// and anything already in process.env wins over the file.
// EVALS_ENV_FILE overrides the path (tests point it at a missing file so a
// developer's real .env.local never leaks into the test process).
const envFile = process.env.EVALS_ENV_FILE ?? new URL("../.env.local", import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

const TEST_URL = process.env.TEST_DATABASE_URL || "postgres://ubuntu:ubuntu@localhost:5432/voicebot_test";
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.TEST_DATABASE_URL = TEST_URL;
process.env.DATABASE_URL = TEST_URL;
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "eval-secret-not-a-real-credential";

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error("evals: GEMINI_API_KEY is required (the eval runs the real model).");
  process.exit(1);
}
