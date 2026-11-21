import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { POST as turnsPost, GET as turnsGet } from "@/app/api/turns/route";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const SID = "s-abc123-xyz";
const apiTurn = {
  id: "11111111-1111-4111-8111-111111111111",
  session_id: SID,
  role: "assistant",
  text: "hello!",
  latency_ms: 120,
  stt_ms: null,
  first_token_ms: 40,
  total_llm_ms: null,
  tts_start_ms: null,
  created_at: "2026-11-22T10:00:00Z",
};
const webTurn = {
  id: apiTurn.id,
  sessionId: SID,
  role: "assistant",
  text: "hello!",
  latencyMs: 120,
  sttMs: null,
  firstTokenMs: 40,
  totalLlmMs: null,
  ttsStartMs: null,
  createdAt: "2026-11-22T10:00:00.000Z",
};

const post = (body: unknown) =>
  new Request("http://localhost:3000/api/turns", { method: "POST", body: JSON.stringify(body) }) as any;
const get = (q = "") => new Request(`http://localhost:3000/api/turns${q}`) as any;

function stubApi(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const calls: { method: string; url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request) => {
      calls.push({ method: input.method, url: input.url, body: input.method === "POST" ? await input.text() : "" });
      return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });
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
  process.env.ROUTE_TURNS = "fastapi";
});

afterEach(() => {
  delete process.env.ROUTE_TURNS;
  vi.unstubAllGlobals();
});

describe("/api/turns with ROUTE_TURNS=fastapi", () => {
  it("POST maps the body to the API and the reply back to the web shape", async () => {
    const calls = stubApi(200, { session_id: SID, turns: [apiTurn] });
    const res = await turnsPost(
      post({ sessionId: SID, mode: "gemini", turns: [{ role: "assistant", text: " hello! ", latencyMs: 120, firstTokenMs: 40 }] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, turns: [webTurn] });
    expect(calls[0].url).toBe(`http://api.test/v1/sessions/${SID}/turns`);
    expect(JSON.parse(calls[0].body)).toEqual({
      mode: "gemini",
      turns: [{ role: "assistant", text: "hello!", latency_ms: 120, first_token_ms: 40 }],
    });
  });

  it("POST into someone else's session: the API's 404 stays a 404", async () => {
    stubApi(404, { status: 404, detail: "Session not found" });
    const res = await turnsPost(post({ sessionId: SID, turns: [{ role: "user", text: "x" }] }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("POST still validates before calling the API", async () => {
    const calls = stubApi(200, {});
    const res = await turnsPost(post({ sessionId: SID, turns: [{ role: "robot", text: "x" }] }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("POST passes 429 through with Retry-After", async () => {
    stubApi(429, { status: 429 }, { "Retry-After": "9" });
    const res = await turnsPost(post({ sessionId: SID, turns: [{ role: "user", text: "x" }] }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
  });

  it("GET lists all my sessions", async () => {
    const calls = stubApi(200, { sessions: [SID], turns: [apiTurn] });
    const res = await turnsGet(get());
    expect(await res.json()).toEqual({ sessions: [SID], turns: [webTurn] });
    expect(calls[0].url).toBe("http://api.test/v1/turns");
  });

  it("GET ?sessionId reads one session, 404 when not mine", async () => {
    const calls = stubApi(200, { session_id: SID, turns: [apiTurn] });
    expect(await (await turnsGet(get(`?sessionId=${SID}`))).json()).toEqual({ sessionId: SID, turns: [webTurn] });
    expect(calls[0].url).toBe(`http://api.test/v1/sessions/${SID}/turns`);

    stubApi(404, { status: 404 });
    const res = await turnsGet(get(`?sessionId=${SID}`));
    expect(res.status).toBe(404);
  });
});
