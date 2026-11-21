// Alembic (services/api) is the only migration tool. Web tests, `pnpm db:migrate`
// and the evals call this to build or upgrade a database. Needs `uv` on PATH.
// Existing Drizzle-built databases must be stamped first (docs/runbooks/alembic-cutover.md).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../services/api");

export function alembicUpgrade(databaseUrl, target = "head") {
  const r = spawnSync("uv", ["run", "--frozen", "alembic", "upgrade", target], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
  });
  if (r.error) throw new Error(`alembic: could not start uv (${r.error.message}). Is uv installed and on PATH?`);
  if (r.status !== 0) throw new Error(`alembic upgrade ${target} failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
}
