import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { POST as voiceToolPost } from "@/app/api/voice/tool/route";
import { getTool } from "@/agent/tools/all";
import { db, upsertUserByEmail, saveResume, createInterview, listInterviewQa, getAgentSteps } from "@/lib/db";
import { interviews } from "@/lib/db/schema";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

// Any outbound call (Gemini) during a cross-user request is itself a failure:
// the ownership check must reject before a paid model call happens.
const fetchSpy = vi.fn(async () => {
  throw new Error("unexpected outbound fetch");
});

function toolReq(body: unknown) {
  return new Request("http://localhost:3000/api/voice/tool", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

const QUESTION_ID = "00000000-0000-4000-8000-000000000001";

// User A owns an interview with an attached résumé. Returns the ids the
// cross-user tests aim at.
async function seedInterviewForA() {
  const a = await upsertUserByEmail("user-a@example.com");
  await upsertUserByEmail("user-b@example.com");
  const resume = await saveResume({
    userId: a!.id,
    filename: "a.pdf",
    rawText: "SECRET RESUME TEXT",
    skills: ["secret-skill"],
    projects: [{ name: "SecretProject", summary: "A private project." }],
    experience: [{ company: "SecretCo", role: "Engineer", period: "2024" }],
  });
  const iv = await createInterview(a!.id, "backend", "mid");
  await db.update(interviews).set({ resumeId: resume.id }).where(eq(interviews.id, iv.id));
  return { userAId: a!.id, interviewId: iv.id };
}

async function interviewRow(id: string) {
  const [row] = await db.select().from(interviews).where(eq(interviews.id, id));
  return row;
}

beforeEach(async () => {
  await resetDb();
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  testAuth.asA();
});

describe("POST /api/voice/tool — ownership", () => {
  it("owner can read their own résumé (happy path)", async () => {
    const { interviewId } = await seedInterviewForA();
    const res = await voiceToolPost(toolReq({ name: "read_resume", args: {}, interviewId }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.result.skills).toEqual(["secret-skill"]);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const { interviewId } = await seedInterviewForA();
    testAuth.signOut();
    const res = await voiceToolPost(toolReq({ name: "read_resume", args: {}, interviewId }));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed interviewId with 400", async () => {
    const res = await voiceToolPost(toolReq({ name: "read_resume", args: {}, interviewId: "not-a-uuid" }));
    expect(res.status).toBe(400);
  });

  it("read_resume on another user's interview → 404, no résumé data", async () => {
    const { interviewId } = await seedInterviewForA();
    testAuth.asB();
    const res = await voiceToolPost(toolReq({ name: "read_resume", args: {}, interviewId }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/secret/i);
  });

  it("get_question(use_resume) on another user's interview → 404, no résumé data", async () => {
    const { interviewId } = await seedInterviewForA();
    testAuth.asB();
    const res = await voiceToolPost(
      toolReq({ name: "get_question", args: { role: "backend", level: "mid", use_resume: true }, interviewId }),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/secret/i);
  });

  it("evaluate_answer on another user's interview → 404, nothing saved, no model call", async () => {
    const { interviewId } = await seedInterviewForA();
    testAuth.asB();
    const res = await voiceToolPost(
      toolReq({ name: "evaluate_answer", args: { question_id: QUESTION_ID, answer_text: "injected" }, interviewId }),
    );
    expect(res.status).toBe(404);
    expect(await listInterviewQa(interviewId)).toHaveLength(0);
    expect(await getAgentSteps(interviewId)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("end_interview on another user's interview → 404, interview unchanged", async () => {
    const { interviewId } = await seedInterviewForA();
    const before = await interviewRow(interviewId);
    testAuth.asB();
    const res = await voiceToolPost(toolReq({ name: "end_interview", args: {}, interviewId }));
    expect(res.status).toBe(404);
    const after = await interviewRow(interviewId);
    expect(after.status).toBe(before.status);
    expect(after.currentQuestionIndex).toBe(before.currentQuestionIndex);
    expect(await getAgentSteps(interviewId)).toHaveLength(0);
  });

  it("owner can end their own interview (happy path)", async () => {
    const { interviewId } = await seedInterviewForA();
    const res = await voiceToolPost(toolReq({ name: "end_interview", args: {}, interviewId }));
    expect(res.status).toBe(200);
    expect((await interviewRow(interviewId)).status).toBe("complete");
  });
});

// Defence in depth: tool handlers must refuse a foreign interview even if a
// caller forgets the route-level check.
describe("interview tool handlers — user scoping", () => {
  it("handlers refuse an interview the context user does not own", async () => {
    const { interviewId } = await seedInterviewForA();
    const b = await upsertUserByEmail("user-b@example.com");
    const ctx = { userId: b!.id, interviewId };
    const before = await interviewRow(interviewId);

    const resume = await getTool("read_resume")!.handler({}, ctx);
    expect(JSON.stringify(resume)).not.toMatch(/secret/i);

    const q = await getTool("get_question")!.handler({ role: "backend", level: "mid", use_resume: true }, ctx);
    expect(JSON.stringify(q)).not.toMatch(/secret/i);

    const evaluation = await getTool("evaluate_answer")!.handler({ question_id: QUESTION_ID, answer_text: "x" }, ctx);
    expect(evaluation).toMatchObject({ error: expect.any(String) });
    expect(fetchSpy).not.toHaveBeenCalled();

    await getTool("end_interview")!.handler({}, ctx);
    const after = await interviewRow(interviewId);
    expect(after.status).toBe(before.status);
    expect(after.currentQuestionIndex).toBe(before.currentQuestionIndex);
    expect(await listInterviewQa(interviewId)).toHaveLength(0);
  });
});
