import { describe, it, expect } from "vitest";
import postgres from "postgres";
import { resetDb } from "./setup";

// resetDb wipes per-test data from EVERY table (including ones added after
// this test was written) but keeps the seeded question bank, which is
// reference data, not per-test state.
const TEST_URL = process.env.TEST_DATABASE_URL!;

async function counts(sql: postgres.Sql) {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    out[table_name] = (await sql`select count(*)::int as n from ${sql(table_name)}`)[0].n;
  }
  return out;
}

describe("resetDb", () => {
  it("empties every table except the question bank", async () => {
    const sql = postgres(TEST_URL, { max: 1, onnotice: () => {} });
    try {
      await sql`insert into questions (category, text) values ('backend', 'resetDb test question') on conflict do nothing`;
      const [user] = await sql`insert into users (email) values ('reset@example.com') returning id`;
      await sql`insert into token_usage (user_id, day, tokens_in, tokens_out) values (${user.id}, '2026-01-01', 1, 1)`;
      const before = await counts(sql);

      await resetDb();

      const after = await counts(sql);
      expect(after.questions).toBe(before.questions);
      expect(after.questions).toBeGreaterThan(0);
      for (const [table, n] of Object.entries(after)) {
        if (table === "alembic_version") expect(n, "schema revision is kept").toBe(1);
        else if (table !== "questions") expect(n, `${table} should be empty`).toBe(0);
      }
    } finally {
      await sql.end();
    }
  });
});
