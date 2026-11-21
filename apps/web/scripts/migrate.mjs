// Migrates DATABASE_URL with Alembic (services/api), the only migration tool:
// creates pgvector and applies every revision. Usage: pnpm db:migrate
import { alembicUpgrade } from "./alembic-upgrade.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("db:migrate: DATABASE_URL is not set");
  process.exit(1);
}
alembicUpgrade(url);
console.log("db:migrate: migrations applied");
