// Test setup: point Drizzle at the dedicated test database. Tests NEVER
// touch the dev/prod database: src/lib/db/client.ts refuses to boot when
// NODE_ENV=test unless DATABASE_URL equals TEST_DATABASE_URL.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const TEST_URL = process.env.TEST_DATABASE_URL || "postgres://ubuntu:ubuntu@localhost:5432/voicebot_test";
process.env.TEST_DATABASE_URL = TEST_URL;
process.env.DATABASE_URL = TEST_URL; // client.ts reads this; same test db
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-a-real-credential";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
process.env.GEMINI_MODEL = "gemini-3.5-flash";

// Guard: the client module throws unless NODE_ENV=test; vitest sets it.
if (process.env.NODE_ENV !== "test") {
  throw new Error("Tests must run with NODE_ENV=test");
}

// Apply migrations once per test run.
const migrator = postgres(TEST_URL, { max: 1 });
await migrate(drizzle(migrator), { migrationsFolder: "./drizzle" });
await migrator.end();

// Per-test cleanup: wipe all rows between tests.
export async function resetDb() {
  const sql = postgres(TEST_URL, { max: 1 });
  await sql`TRUNCATE turns, sessions, users CASCADE`;
  await sql.end();
}
