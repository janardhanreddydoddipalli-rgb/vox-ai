import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// One pooled client per process. Neon (serverless) needs the pooled
// connection string; local dev uses the same variable.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. See .env.example.");
}

// Guardrail: under test, refuse anything but the dedicated test database so a
// missing/misrouted env var can never wipe staging or production data.
if (process.env.NODE_ENV === "test") {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl || !connectionString.startsWith(testUrl.split("?")[0])) {
    throw new Error(
      "Refusing to run tests against a non-test database. Set DATABASE_URL to TEST_DATABASE_URL.",
    );
  }
}

const client = postgres(connectionString, { prepare: false, max: 10 });

export const db = drizzle(client, { schema });
export { schema };
