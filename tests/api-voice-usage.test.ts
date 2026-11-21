import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { POST as usagePost } from "@/app/api/voice/usage/route";
import { POST as voiceToolPost } from "@/app/api/voice/tool/route";
import { db, upsertUserByEmail, createInterview } from "@/lib/db";
import { tokenUsage, interviews } from "@/lib/db/schema";
import { DAILY_TOKEN_BUDGET, recordTokenUsage, todayUtc } from "@/lib/cost-guard";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

function post(url: string, body: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

async function seed() {
  const a = await upsertUserByEmail("user-a@example.com");
  await upsertUserByEmail("user-b@example.com");
  const iv = await createInterview(a!.id, "backend", "mid");
  return { userAId: a!.id, interviewId: iv.id };
}

async function usageRow(userId: string) {
  const [row] = await db
    .select()
    .from(tokenUsage)
    .where(and(eq(tokenUsage.userId, userId), eq(tokenUsage.day, todayUtc())));
  return row ?? null;
}

beforeEach(async () => {
  await resetDb();
  testAuth.asA();
});

describe("POST /api/voice/usage", () => {
  it("records live-session token usage against the daily budget", async () => {
    const { userAId, interviewId } = await seed();
    const res = await usagePost(post("/api/voice/usage", { interviewId, promptTokens: 1200, responseTokens: 300 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, budgetExceeded: false });
    const row = await usageRow(userAId);
    expect(row?.tokensIn).toBe(1200);
    expect(row?.tokensOut).toBe(300);
  });

  it("reports budgetExceeded once the user is over the daily budget", async () => {
    const { interviewId } = await seed();
    const res = await usagePost(
      post("/api/voice/usage", { interviewId, promptTokens: DAILY_TOKEN_BUDGET, responseTokens: 1 }),
    );
    const data = await res.json();
    expect(data.budgetExceeded).toBe(true);
    expect(data.message).toMatch(/budget/i);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const { interviewId } = await seed();
    testAuth.signOut();
    const res = await usagePost(post("/api/voice/usage", { interviewId, promptTokens: 1, responseTokens: 1 }));
    expect(res.status).toBe(401);
  });

  it("rejects negative or absurd token counts with 400", async () => {
    const { interviewId } = await seed();
    for (const bad of [{ promptTokens: -1, responseTokens: 0 }, { promptTokens: 10_000_000, responseTokens: 0 }]) {
      const res = await usagePost(post("/api/voice/usage", { interviewId, ...bad }));
      expect(res.status).toBe(400);
    }
  });

  it("another user's interview → 404 and nothing recorded", async () => {
    const { interviewId } = await seed();
    testAuth.asB();
    const b = await upsertUserByEmail("user-b@example.com");
    const res = await usagePost(post("/api/voice/usage", { interviewId, promptTokens: 500, responseTokens: 500 }));
    expect(res.status).toBe(404);
    expect(await usageRow(b!.id)).toBeNull();
  });
});

describe("POST /api/voice/tool — cost guard", () => {
  it("refuses tool calls when the user is over the daily budget, without running the tool", async () => {
    const { userAId, interviewId } = await seed();
    await recordTokenUsage(userAId, DAILY_TOKEN_BUDGET, 0);
    const res = await voiceToolPost(post("/api/voice/tool", { name: "end_interview", args: {}, interviewId }));
    const data = await res.json();
    expect(data).toMatchObject({ ok: false, error: "budget_exceeded" });
    const [row] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
    expect(row.status).toBe("active");
  });
});
