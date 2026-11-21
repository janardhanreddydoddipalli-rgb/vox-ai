import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// From M2, Alembic (services/api) owns migrations; Drizzle is frozen at 0008.
// Schema changes go into a new Alembic revision; see
// docs/runbooks/alembic-cutover.md. The Alembic baseline is pinned to
// exactly this schema by services/api/tests/test_schema_baseline.py.
const DRIZZLE = path.resolve(__dirname, "../drizzle");

describe("Drizzle migrations are frozen", () => {
  it("stop at 0008_interview_qa_unique_order", () => {
    const journal = JSON.parse(readFileSync(path.join(DRIZZLE, "meta/_journal.json"), "utf8"));
    const tags = journal.entries.map((e: { tag: string }) => e.tag);
    expect(tags).toHaveLength(9);
    expect(tags.at(-1)).toBe("0008_interview_qa_unique_order");
  });

  it("have no SQL files beyond the journal", () => {
    const sql = readdirSync(DRIZZLE).filter((f) => f.endsWith(".sql"));
    expect(sql).toHaveLength(9);
  });
});
