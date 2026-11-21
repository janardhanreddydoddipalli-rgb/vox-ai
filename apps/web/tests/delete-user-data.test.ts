import { describe, it, expect, beforeEach } from "vitest";
import postgres from "postgres";
import { deleteAllUserData } from "@/lib/db";
import { resetDb } from "./setup";

// Privacy guarantee behind "Delete my data": removing a user removes every
// row that belongs to them, in every table, and nothing of anyone else's.
const TEST_URL = process.env.TEST_DATABASE_URL!;
const zeroVector = `[${Array(768).fill(0).join(",")}]`;

async function seedUser(sql: postgres.Sql, email: string) {
  const [u] = await sql`insert into users (email) values (${email}) returning id`;
  const sid = `sess-${email}`;
  await sql`insert into sessions (id, user_id, mode) values (${sid}, ${u.id}, 'gemini')`;
  await sql`insert into turns (session_id, role, text) values (${sid}, 'user', 'hello')`;
  const [r] = await sql`insert into resumes (user_id, filename, raw_text, skills, projects, experience)
    values (${u.id}, 'cv.pdf', 'text', '[]', '[]', '[]') returning id`;
  const [iv] = await sql`insert into interviews (user_id, role, level, resume_id) values (${u.id}, 'backend', 'mid', ${r.id}) returning id`;
  await sql`insert into interview_qa (interview_id, "order", question_text, answer_text) values (${iv.id}, 0, 'q', 'a')`;
  await sql`insert into agent_steps (interview_id, step_index, tool_name, input, output, duration_ms) values (${iv.id}, 0, 't', '{}', '{}', 1)`;
  await sql`insert into user_memories (user_id, kind, text, embedding) values (${u.id}, 'weakness', 'x', ${zeroVector})`;
  await sql`insert into doc_chunks (user_id, source, text, embedding) values (${u.id}, 'resume', 'x', ${zeroVector})`;
  await sql`insert into token_usage (user_id, day, tokens_in, tokens_out) values (${u.id}, '2026-01-01', 1, 1)`;
  return u.id as string;
}

async function rowCounts(sql: postgres.Sql) {
  const tables = await sql<{ table_name: string }[]>`select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not in ('questions', 'alembic_version')`;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) out[table_name] = (await sql`select count(*)::int as n from ${sql(table_name)}`)[0].n;
  return out;
}

beforeEach(async () => {
  await resetDb();
});

describe("deleteAllUserData", () => {
  it("removes every row of the user in every table and leaves other users intact", async () => {
    const sql = postgres(TEST_URL, { max: 1, onnotice: () => {} });
    try {
      const a = await seedUser(sql, "a@example.com");
      await seedUser(sql, "b@example.com");
      const before = await rowCounts(sql);
      for (const [t, n] of Object.entries(before)) expect(n, `seed should fill ${t}`).toBe(2);

      await deleteAllUserData(a);

      const after = await rowCounts(sql);
      for (const [t, n] of Object.entries(after)) expect(n, `${t} should keep only user B's row`).toBe(1);
    } finally {
      await sql.end();
    }
  });
});
