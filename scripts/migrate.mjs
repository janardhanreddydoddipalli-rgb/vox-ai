// Applies the Drizzle migrations to DATABASE_URL, creating the pgvector
// extension first: no Drizzle migration does (0005 assumes it exists), so a
// fresh database (CI, new Neon branch, new laptop) fails without it.
// Usage: DATABASE_URL=postgres://... npm run db:migrate
// The M2 Alembic baseline owns this properly (see docs/verification.md).
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:migrate: DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
  console.log("db:migrate: migrations applied");
} finally {
  await sql.end();
}
