# Runbook: hand migrations over from Drizzle to Alembic

From M2, **Alembic (`services/api/alembic`) is the only migration tool.** Drizzle was removed from the repo in M4; its migrations 0000–0008 stay in git history.

The Alembic baseline (`0001_baseline.py`) builds exactly the schema that Drizzle migrations 0000–0008 built. This is proven by an empty `pg_dump --schema-only` diff (M2 report) and pinned by `services/api/tests/test_schema_baseline.py` in CI.

## Which command for which database

| Database | State | Command |
|---|---|---|
| **Existing, already migrated by Drizzle** (Neon Singapore `production`, any Neon branch made from it) | Has every table | **`alembic stamp 0001`**. Records the baseline as applied **without running it**. |
| **New, empty** (CI, a new Neon project or branch made empty, a new laptop) | No tables | `alembic upgrade head` (creates pgvector, then everything) |

**Never run `alembic upgrade` on a database Drizzle already migrated before it's stamped.** The baseline's `CREATE TABLE` statements would fail on existing tables. It runs in one transaction, so nothing would change, but the cutover would be blocked.

## Local and test databases

`pnpm db:migrate`, the API tests and the evals run Alembic. A local database that Drizzle built earlier has no `alembic_version` table, so `upgrade` fails on existing tables. Either recreate it (it's test data), or stamp it: `uv run --directory services/api alembic stamp 0001` with `DATABASE_URL` set.

## Cutover steps for Neon (production)

Needs explicit approval. Run from `services/api` with the **direct** (non-pooler) URL kept in `apps/web/.env.neon.local`.

1. **Back up:** in the Neon console, create a branch from `production` named `backup-pre-alembic`.
2. **Check that it really is the Drizzle schema** (read-only: catalog SELECTs in a read-only session):
   ```bash
   uv run --env-file ../../apps/web/.env.neon.local python scripts/verify_drizzle_schema.py
   ```
   It must end with `RESULT: matches Drizzle 0000-0008, safe to stamp 0001` (exit 0). If not, stop: the database has drifted.
3. **Stamp:**
   ```bash
   uv run --env-file ../../apps/web/.env.neon.local alembic stamp 0001
   uv run --env-file ../../apps/web/.env.neon.local alembic current   # → 0001 (head)
   ```
4. **Upgrade to head:** `uv run --env-file ../../apps/web/.env.neon.local alembic upgrade head` applies the later revisions (`0002` voice sessions, `0003` embedding model per row and full-text search). They are expand-only, so the web version still in production keeps working. Contract steps (e.g. dropping the `embedding_model` defaults) wait until that old web version is gone.

## Rollback

Stamping only writes the `alembic_version` table. To undo, drop that table: `DROP TABLE alembic_version;`. No schema changes to reverse.

## Status

| Database | Stamped? |
|---|---|
| Neon Singapore `production` | **Not yet.** Verified on 2026-11-22 that it matches Drizzle 0000-0008 exactly (`verify_drizzle_schema.py`: columns, constraints, indexes and extensions identical). Stamp in M5, before the first API deploy (needs approval). |
