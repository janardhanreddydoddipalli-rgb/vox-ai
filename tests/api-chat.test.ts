import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { POST as chatPost } from "@/app/api/chat/route";
import { GET as healthGet } from "@/app/api/health/route";
import { mockGeminiOk, mockGeminiFailure } from "./gemini-mock";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const authState = testAuth;

function req(body: unknown, origin?: string) {
  return new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  }) as any;
}

beforeAll(async () => {});
beforeEach(async () => {
  mockGeminiOk("Test reply");
  await resetDb();
  authState.asA();
});

describe("POST /api/chat", () => {
  it("returns a Gemini reply on the happy path", async () => {
    const res = await chatPost(req({ userText: "hello" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reply).toBe("Test reply");
    expect(data.engine).toBe("gemini");
  });

  it("rejects empty message with 400", async () => {
    const res = await chatPost(req({ userText: "" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe("string");
  });

  it("rejects message over 2000 chars with 400", async () => {
    const res = await chatPost(req({ userText: "a".repeat(2001) }));
    expect(res.status).toBe(400);
  });

  it("rejects more than 20 history items with 400", async () => {
    const history = Array.from({ length: 21 }, (_, i) => ({ role: "user", text: `m${i}` }));
    const res = await chatPost(req({ userText: "hi", history }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid history role with 400", async () => {
    const res = await chatPost(req({ userText: "hi", history: [{ role: "system", text: "x" }] }));
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const r = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }) as any;
    const res = await chatPost(r);
    expect(res.status).toBe(400);
  });

  it("falls back to offline engine when Gemini fails", async () => {
    mockGeminiFailure(500);
    const res = await chatPost(req({ userText: "what time is it?" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.engine).toBe("offline");
    expect(typeof data.reply).toBe("string");
  });

  it("rejects a cross-origin request with 403", async () => {
    const res = await chatPost(req({ userText: "hi" }, "https://evil.example"));
    expect(res.status).toBe(403);
  });

  it("allows anonymous chat (rate limited by IP)", async () => {
    authState.signOut();
    const res = await chatPost(req({ userText: "hi" }));
    expect(res.status).toBe(200);
    authState.asA();
  });

  it("is POST-only", async () => {
    const mod = await import("@/app/api/chat/route");
    expect((mod as any).GET).toBeUndefined();
  });
});

describe("GET /api/health", () => {
  it("reports engine, model and postgres status", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.engine).toBe("gemini");
    expect(data.model).toBe("gemini-3.5-flash");
    expect(data.db).toBe("ok");
    expect(data.ok).toBe(true);
  });
});
