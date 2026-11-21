// Point the db module at a throwaway temp file per test run so tests can
// never touch the real data/voicebot.db. Loaded via vitest setupFiles,
// before any module imports @/lib/db.
import fs from "fs";
import os from "os";
import path from "path";

// Vitest sets NODE_ENV=test itself; db.ts refuses the default path in that mode.
process.env.ADMIN_TOKEN = "test-admin-token";
process.env.GEMINI_API_KEY = "test-key";
process.env.GEMINI_MODEL = "gemini-3.5-flash";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voicebot-test-"));
process.env.VOICEBOT_DB_PATH = path.join(tmp, "test.db");

export const TEST_ADMIN_TOKEN = process.env.ADMIN_TOKEN;

export function resetDb() {
  // each test file gets a fresh tmp db via env above
}
