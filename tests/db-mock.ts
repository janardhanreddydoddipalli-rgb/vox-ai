// Point the db module at a throwaway temp file per test run so tests never
// touch data/voicebot.db. Must be imported before any route module.
import fs from "fs";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voicebot-test-"));
process.env.VOICEBOT_DB_PATH = path.join(tmp, "test.db");

export function resetDb() {
  // nothing per-test yet: each test file gets a fresh tmp db via env above
}
