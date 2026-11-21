// Eval environment: must run before any app import (mirrors tests/setup.ts).
// Loads .env.local, forces the dedicated test database, and requires a real
// GEMINI_API_KEY — the eval exercises the live model, not a mock.
import { readFileSync } from "node:fs";

// Minimal .env.local loader (KEY=VALUE lines) so `npm run eval` works without dotenv.
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
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
