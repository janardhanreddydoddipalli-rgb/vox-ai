import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { POST as chatPost } from "@/app/api/chat/route";
import { readSse } from "./gemini-mock";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const IV = "44444444-4444-4444-8444-444444444444";
const SSE = 'event: meta\ndata: {"engine":"gemini","mode":"interview"}\n\nevent: done\ndata: {"tool_steps":1}\n\n';

const req = (body: unknown) =>
  new Request("http://localhost:3000/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;

function stubApi(routes: Record<string, () => Response>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const key = `${init.method ?? "GET"} ${new URL(url).pathname}`;
      calls.push({ key, body: init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(String(init.body)) });
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
  process.env.ROUTE_AGENT = "fastapi";
});

afterEach(() => {
  process.env.ROUTE_AGENT = "next";
  vi.unstubAllGlobals();
});

describe("/api/chat interview mode with ROUTE_AGENT=fastapi", () => {
  it("forwards the turn and passes the SSE stream through", async () => {
    const calls = stubApi({ [`POST /v1/interviews/${IV}/turns`]: () => new Response(SSE, { headers: { "content-type": "text/event-stream" } }) });
    const res = await chatPost(req({ userText: "my answer", interviewId: IV, history: [{ role: "assistant", text: "Q?" }] }));
    expect(await res.text()).toBe(SSE);
    expect(calls[0].body).toEqual({ user_text: "my answer", history: [{ role: "assistant", text: "Q?" }] });
  });

  it("an unknown or foreign interview keeps the web's in-stream message", async () => {
    stubApi({ [`POST /v1/interviews/${IV}/turns`]: () => new Response(JSON.stringify({ status: 404 }), { status: 404 }) });
    const events = await readSse(await chatPost(req({ userText: "hi", interviewId: IV })));
    expect(events.map((e) => e.event)).toEqual(["meta", "token", "sentence", "done"]);
    expect(events[0].data).toEqual({ engine: "offline", reason: "Interview not found" });
    expect(events[2].data.text).toBe("I couldn't find that interview.");
  });

  it("starting a new interview creates it via the API first", async () => {
    const calls = stubApi({
      "POST /v1/interviews": () => new Response(JSON.stringify({ id: IV }), { status: 201 }),
      [`POST /v1/interviews/${IV}/turns`]: () => new Response(SSE),
    });
    await (await chatPost(req({ userText: "start", interview: { role: "Backend", level: "mid" } }))).text();
    expect(calls.map((c) => c.key)).toEqual(["POST /v1/interviews", `POST /v1/interviews/${IV}/turns`]);
    expect(calls[0].body).toEqual({ role: "Backend", level: "mid" });
  });

  it("signed-out callers get the sign-in message without an API call", async () => {
    testAuth.signOut();
    const calls = stubApi({});
    const events = await readSse(await chatPost(req({ userText: "hi", interviewId: IV })));
    expect(events[0].data.reason).toBe("Sign in to use interview mode");
    expect(calls).toHaveLength(0);
  });
});
