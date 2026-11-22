import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { POST as sessionPost } from "@/app/api/voice/session/route";
import { POST as toolPost } from "@/app/api/voice/tool/route";
import { POST as usagePost } from "@/app/api/voice/usage/route";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const IV = "44444444-4444-4444-8444-444444444444";
const SID = "55555555-5555-4555-8555-555555555555";

const post = (url: string, body: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;

const problem = (status: number, detail: string, extra: object = {}) =>
  new Response(JSON.stringify({ status, title: "x", type: "about:blank", detail, ...extra }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

function stubApi(routes: Record<string, () => Response>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      const key = `${input.method} ${new URL(input.url).pathname}`;
      calls.push({ key, body: JSON.parse(await input.text()) });
      const make = routes[key];
      if (!make) throw new Error(`unexpected API call ${key}`);
      return make();
    }),
  );
  return calls;
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  process.env.API_JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.API_INTERNAL_URL = "http://api.test";
});

beforeEach(async () => {
  await resetDb();
  testAuth.asA();
  process.env.ROUTE_VOICE = "fastapi";
});

afterEach(() => {
  delete process.env.ROUTE_VOICE;
  vi.unstubAllGlobals();
});

describe("/api/voice/session with ROUTE_VOICE=fastapi", () => {
  it("binds the session to the interview and returns the web's camelCase config", async () => {
    const tools = [{ name: "get_question", description: "d", parameters: { type: "object", properties: {} } }];
    const calls = stubApi({
      "POST /v1/voice/sessions": () =>
        Response.json(
          { session_id: SID, token: "auth_tokens/t", model: "models/live", system_instruction: "S", tools, expires_in_sec: 1800 },
          { status: 201 },
        ),
    });
    const res = await sessionPost(post("/api/voice/session", { language: "hi", interviewId: IV }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: SID,
      token: "auth_tokens/t",
      model: "models/live",
      systemInstruction: "S",
      tools,
      expiresInSec: 1800,
    });
    expect(calls[0].body).toEqual({ interview_id: IV, language: "hi" });
  });

  it("keeps the web's error contract: budget, foreign interview, no key", async () => {
    const cases: [Response, number, object][] = [
      [problem(429, "You've reached today's budget", { code: "budget_exceeded" }), 429, { error: "budget_exceeded", message: "You've reached today's budget" }],
      [problem(404, "Interview not found"), 404, { error: "Interview not found" }],
      [problem(503, "Voice service is not configured"), 503, { error: "Voice service is not configured" }],
      [problem(502, "Could not start live voice"), 502, { error: "Could not start live voice" }],
    ];
    for (const [upstream, status, body] of cases) {
      stubApi({ "POST /v1/voice/sessions": () => upstream });
      const res = await sessionPost(post("/api/voice/session", {}));
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    }
  });

  it("rejects an unsupported language and signed-out callers without an API call", async () => {
    const calls = stubApi({});
    expect((await sessionPost(post("/api/voice/session", { language: "fr" }))).status).toBe(400);
    testAuth.signOut();
    expect((await sessionPost(post("/api/voice/session", {}))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("/api/voice/tool with ROUTE_VOICE=fastapi", () => {
  const path = `POST /v1/voice/sessions/${SID}/tool-calls`;

  it("forwards the call under the session with Gemini's call id", async () => {
    const calls = stubApi({ [path]: () => Response.json({ ok: true, result: { question: "Q?" }, error: null, message: null }) });
    const res = await toolPost(post("/api/voice/tool", { name: "get_question", args: { level: "mid" }, interviewId: IV, sessionId: SID, callId: "fc-1" }));
    expect(await res.json()).toEqual({ ok: true, result: { question: "Q?" } });
    // The interview comes from the session on the server, never from this body.
    expect(calls[0].body).toEqual({ call_id: "fc-1", name: "get_question", args: { level: "mid" } });
  });

  it("passes tool failures through and generates a call id when Gemini sent none", async () => {
    const calls = stubApi({ [path]: () => Response.json({ ok: false, result: null, error: "budget_exceeded", message: "Paused" }) });
    const res = await toolPost(post("/api/voice/tool", { name: "get_question", sessionId: SID }));
    expect(await res.json()).toEqual({ ok: false, error: "budget_exceeded", message: "Paused" });
    expect((calls[0].body as { call_id: string }).call_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps a foreign or expired session to the error body the engine reads", async () => {
    stubApi({ [path]: () => problem(404, "Voice session not found") });
    const missing = await toolPost(post("/api/voice/tool", { name: "x", sessionId: SID, callId: "c" }));
    expect([missing.status, await missing.json()]).toEqual([404, { error: "Voice session not found" }]);
    stubApi({ [path]: () => problem(410, "Voice session expired") });
    const expired = await toolPost(post("/api/voice/tool", { name: "x", sessionId: SID, callId: "c" }));
    expect([expired.status, await expired.json()]).toEqual([410, { error: "Voice session expired" }]);
  });

  it("needs the session id", async () => {
    const calls = stubApi({});
    expect((await toolPost(post("/api/voice/tool", { name: "get_question", interviewId: IV }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("/api/voice/usage with ROUTE_VOICE=fastapi", () => {
  it("records under the session and returns the budget verdict", async () => {
    const calls = stubApi({
      [`POST /v1/voice/sessions/${SID}/usage`]: () => Response.json({ budget_exceeded: true, message: "Paused" }),
    });
    const res = await usagePost(post("/api/voice/usage", { sessionId: SID, interviewId: IV, promptTokens: 120, responseTokens: 30 }));
    expect(await res.json()).toEqual({ ok: true, budgetExceeded: true, message: "Paused" });
    expect(calls[0].body).toEqual({ prompt_tokens: 120, response_tokens: 30 });
  });

  it("needs the session id and maps a foreign session to 404", async () => {
    const calls = stubApi({ [`POST /v1/voice/sessions/${SID}/usage`]: () => problem(404, "Voice session not found") });
    expect((await usagePost(post("/api/voice/usage", { promptTokens: 1, responseTokens: 1 }))).status).toBe(400);
    expect(calls).toHaveLength(0);
    const res = await usagePost(post("/api/voice/usage", { sessionId: SID, promptTokens: 1, responseTokens: 1 }));
    expect(res.status).toBe(404);
  });
});
