import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

// The live-voice session must declare the agent tools by itself. On Vercel
// each route runs in its own function, so it can't rely on another route
// having imported (and so registered) them first.
beforeEach(async () => {
  await resetDb();
  testAuth.asA();
  vi.resetModules();
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/t" }), { status: 200 })) as any;
});

describe("POST /api/voice/session tool declarations", () => {
  it("declares the interview tools even when nothing else registered them", async () => {
    const { POST } = await import("@/app/api/voice/session/route");
    const res = await POST(new Request("http://localhost:3000/api/voice/session", { method: "POST", body: "{}" }) as any);
    const { tools } = await res.json();
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["get_question", "evaluate_answer", "end_interview", "read_resume", "recall_memories", "search_documents"]),
    );
  });
});
