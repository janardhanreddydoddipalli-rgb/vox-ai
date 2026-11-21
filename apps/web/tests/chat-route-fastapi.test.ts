import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { POST as chatPost } from "@/app/api/chat/route";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const SSE = 'event: meta\ndata: {"engine":"gemini"}\n\nevent: sentence\ndata: {"text":"Hi."}\n\nevent: done\ndata: {"total_llm_ms":5}\n\n';

const req = (body: unknown, signal?: AbortSignal) =>
  new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }) as any;

function stubApi(make: () => Response) {
  const calls: { url: string; body: string; signal: AbortSignal | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), signal: init.signal ?? null });
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
  process.env.ROUTE_CHAT = "fastapi";
});

afterEach(() => {
  delete process.env.ROUTE_CHAT;
  vi.unstubAllGlobals();
});

describe("/api/chat with ROUTE_CHAT=fastapi", () => {
  it("passes the API's SSE stream through unchanged", async () => {
    const calls = stubApi(() => new Response(SSE, { headers: { "content-type": "text/event-stream" } }));
    const ctl = new AbortController();
    const res = await chatPost(req({ userText: " hello ", history: [{ role: "assistant", text: "Hi" }] }, ctl.signal));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(SSE);
    expect(calls[0].url).toBe("http://api.test/v1/chat");
    expect(JSON.parse(calls[0].body)).toEqual({ user_text: "hello", history: [{ role: "assistant", text: "Hi" }] });
    // A client disconnect aborts the upstream call.
    expect(calls[0].signal?.aborted).toBe(false);
    ctl.abort();
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it("keeps interview mode in apps/web (no API call)", async () => {
    const calls = stubApi(() => new Response(SSE));
    await chatPost(req({ userText: "hi", interviewId: "11111111-1111-4111-8111-111111111111" }));
    expect(calls.filter((c) => c.url.startsWith("http://api.test"))).toHaveLength(0);
  });

  it("still validates before calling the API", async () => {
    const calls = stubApi(() => new Response(SSE));
    expect((await chatPost(req({ userText: "" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("passes 429 through with Retry-After", async () => {
    stubApi(() => new Response(JSON.stringify({ status: 429 }), { status: 429, headers: { "Retry-After": "12" } }));
    const res = await chatPost(req({ userText: "hi" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });
});
