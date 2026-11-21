import { describe, it, expect, beforeEach } from "vitest";
import { POST as turnsPost, GET as turnsGet } from "@/app/api/turns/route";
import { resetDb, TEST_ADMIN_TOKEN } from "./setup";

function req(body: any) {
  return new Request("http://localhost:3000/api/turns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

const uniqueSid = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

beforeEach(() => {
  resetDb();
});

describe("POST /api/turns", () => {
  it("saves turns and returns them", async () => {
    const sessionId = uniqueSid();
    const res = await turnsPost(
      req({
        sessionId,
        mode: "gemini",
        turns: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello!", latencyMs: 120 }],
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.turns).toHaveLength(2);
    expect(data.turns[0].text).toBe("hi");
  });

  it("rejects missing sessionId with 400", async () => {
    const res = await turnsPost(req({ turns: [{ role: "user", text: "hi" }] }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid role with 400", async () => {
    const res = await turnsPost(req({ sessionId: uniqueSid(), turns: [{ role: "robot", text: "hi" }] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/role/i);
  });

  it("rejects more than 200 turns with 400", async () => {
    const turns = Array.from({ length: 201 }, () => ({ role: "user", text: "x" }));
    const res = await turnsPost(req({ sessionId: uniqueSid(), turns }));
    expect(res.status).toBe(400);
  });

  it("rejects negative latencyMs with 400", async () => {
    const res = await turnsPost(req({ sessionId: uniqueSid(), turns: [{ role: "user", text: "x", latencyMs: -5 }] }));
    expect(res.status).toBe(400);
  });

  it("rejects cross-origin with 403", async () => {
    const r = new Request("http://localhost:3000/api/turns", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ sessionId: uniqueSid(), turns: [{ role: "user", text: "x" }] }),
    }) as any;
    const res = await turnsPost(r);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/turns", () => {
  it("rejects anonymous reads with 401", async () => {
    const r = new Request("http://localhost:3000/api/turns") as any;
    const res = await turnsGet(r);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token with 401", async () => {
    const r = new Request("http://localhost:3000/api/turns", {
      headers: { "x-admin-token": "nope" },
    }) as any;
    const res = await turnsGet(r);
    expect(res.status).toBe(401);
  });

  it("lists sessions with the correct admin token", async () => {
    const r = new Request("http://localhost:3000/api/turns", {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN },
    }) as any;
    const res = await turnsGet(r);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.sessions)).toBe(true);
  });
});
