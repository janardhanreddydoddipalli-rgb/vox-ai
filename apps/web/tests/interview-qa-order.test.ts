import { describe, it, expect, beforeEach } from "vitest";
import { recordQa } from "@/agent/tools/interview-tools";
import { db, upsertUserByEmail, createInterview, listInterviewQa } from "@/lib/db";
import { interviewQa } from "@/lib/db/schema";
import { resetDb } from "./setup";

const EVALUATION = {
  score: 7,
  clarity: "ok",
  depth: "ok",
  correctness: "ok",
  missing_points: [],
  follow_up_needed: false,
};

async function seed() {
  const user = await upsertUserByEmail("user-a@example.com");
  const iv = await createInterview(user!.id, "backend", "mid");
  return { userId: user!.id, interviewId: iv.id };
}

beforeEach(async () => {
  await resetDb();
});

describe("interview_qa ordering", () => {
  it("concurrent answer saves get distinct, gap-free order numbers", async () => {
    const { userId, interviewId } = await seed();
    const ctx = { userId, interviewId };
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => recordQa(ctx, `q${i}`, `Question ${i}`, `Answer ${i}`, EVALUATION)),
    );
    const orders = (await listInterviewQa(interviewId)).map((r) => r.order).sort((a, b) => a - b);
    expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("the database rejects two answers with the same order in one interview", async () => {
    const { interviewId } = await seed();
    const row = { interviewId, order: 0, questionId: null, questionText: "Q", answerText: "A", evaluation: null };
    await db.insert(interviewQa).values(row);
    await expect(db.insert(interviewQa).values(row)).rejects.toThrow();
  });
});
