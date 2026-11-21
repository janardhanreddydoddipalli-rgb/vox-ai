import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { POST as chatPost } from "@/app/api/chat/route";
import { GET as healthGet } from "@/app/api/health/route";
import { mockGeminiOk, mockGeminiFailure, mockGeminiStream, readSse } from "./gemini-mock";
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

describe("POST /api/chat (SSE)", () => {
  it("streams meta, token, sentence and done on the happy path", async () => {
    mockGeminiStream(["The capital ", "of France ", "is Paris. ", "It is in Europe."]);
    const res = await chatPost(req({ userText: "capital of France?" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(res);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("meta");
    expect(events[0].data.engine).toBe("gemini");
    expect(events[0].data.first_token_ms).toBeGreaterThanOrEqual(0);
    expect(names).toContain("token");
    expect(names.filter((n) => n === "sentence").length).toBeGreaterThanOrEqual(2);
    expect(names[names.length - 1]).toBe("done");
    expect(events.at(-1)!.data.total_llm_ms).toBeGreaterThanOrEqual(0);

    const tokens = events.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(tokens).toBe("The capital of France is Paris. It is in Europe.");
    const sentences = events.filter((e) => e.event === "sentence").map((e) => e.data.text);
    expect(sentences).toEqual(["The capital of France is Paris.", "It is in Europe."]);
  });

  it("rejects empty message with 400 before opening the stream", async () => {
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

  it("falls back to offline engine when Gemini fails before the first token", async () => {
    mockGeminiFailure(500);
    const res = await chatPost(req({ userText: "what time is it?" }));
    expect(res.status).toBe(200);
    const events = await readSse(res);
    const meta = events.find((e) => e.event === "meta");
    expect(meta?.data.engine).toBe("offline");
    const done = events.find((e) => e.event === "done");
    expect(done).toBeTruthy();
    const sentences = events.filter((e) => e.event === "sentence").map((e) => e.data.text).join(" ");
    expect(sentences.length).toBeGreaterThan(0);
  });

  it("falls back to offline when the Gemini stream breaks before the first token", async () => {
    mockGeminiStream(["partial"], { failAfter: 0 });
    const res = await chatPost(req({ userText: "hello there" }));
    const events = await readSse(res);
    const meta = events.find((e) => e.event === "meta");
    expect(meta?.data.engine).toBe("offline");
    expect(events.at(-1)!.event).toBe("done");
  });

  it("emits error (not done) when the stream breaks mid-reply", async () => {
    mockGeminiStream(["First sentence. ", "Second on"], { failAfter: 1 });
    const res = await chatPost(req({ userText: "tell me something" }));
    const events = await readSse(res);
    expect(events.find((e) => e.event === "meta")?.data.engine).toBe("gemini");
    expect(events.some((e) => e.event === "error")).toBe(true);
  });

  it("aborts the upstream stream when the client disconnects", async () => {
    let upstreamCancelled = false;
    const enc = new TextEncoder();
    // Sends one chunk then hangs; records cancel() when the route aborts it.
    const hangAfterFirst = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] })}\r\n\r\n`));
      },
      pull() {
        return new Promise(() => {}); // hang forever
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    let upstreamSignalAborted = false;
    const mocked: typeof fetch = async (_url, init) => {
      init?.signal?.addEventListener("abort", () => (upstreamSignalAborted = true));
      return new Response(hangAfterFirst, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    globalThis.fetch = mocked;

    const ctl = new AbortController();
    const r = new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "long story please" }),
      signal: ctl.signal,
    }) as any;

    const res = await chatPost(r);
    const reader = res.body!.getReader();
    await reader.read(); // open the stream
    ctl.abort(); // client disconnects
    // Give the route's abort listener + upstream cancel a moment.
    await new Promise((r2) => setTimeout(r2, 100));
    expect(upstreamSignalAborted).toBe(true);
    expect(upstreamCancelled).toBe(true);
  }, 10000);

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
  it("persists per-turn timings end-to-end", async () => {
    const { POST: turnsPost, GET: turnsGet } = await import("@/app/api/turns/route");
    const { DELETE: deleteMe } = await import("@/app/api/me/delete/route");
    void deleteMe;

    mockGeminiStream(["Hello there. ", "How are you?"]);
    const chatRes = await chatPost(req({ userText: "hi" }));
    const events = await readSse(chatRes);
    const meta = events.find((e) => e.event === "meta")!;
    const done = events.find((e) => e.event === "done")!;

    const sid = `e2e-${Math.random().toString(36).slice(2, 10)}`;
    const saveRes = await turnsPost(
      new Request("http://localhost:3000/api/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: sid,
          mode: "gemini",
          turns: [
            { role: "user", text: "hi", sttMs: 210 },
            {
              role: "assistant",
              text: events.filter((e) => e.event === "sentence").map((e) => e.data.text).join(" "),
              latencyMs: 999,
              firstTokenMs: meta.data.first_token_ms,
              totalLlmMs: done.data.total_llm_ms,
              ttsStartMs: 500,
            },
          ],
        }),
      }) as any,
    );
    expect(saveRes.status).toBe(200);

    const listRes = await turnsGet(
      new Request(`http://localhost:3000/api/turns?sessionId=${sid}`) as any,
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    const assistant = list.turns.find((t: any) => t.role === "assistant");
    expect(assistant.firstTokenMs).toBe(meta.data.first_token_ms);
    expect(assistant.totalLlmMs).toBe(done.data.total_llm_ms);
    expect(assistant.ttsStartMs).toBe(500);
    const user = list.turns.find((t: any) => t.role === "user");
    expect(user.sttMs).toBe(210);
  });

  it("rejects negative timing fields with 400", async () => {
    const { POST: turnsPost } = await import("@/app/api/turns/route");
    const res = await turnsPost(
      new Request("http://localhost:3000/api/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: "x",
          turns: [{ role: "user", text: "hi", firstTokenMs: -1 }],
        }),
      }) as any,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/health", () => {  it("reports engine, model and postgres status", async () => {
    const res = await healthGet();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.engine).toBe("gemini");
    expect(data.model).toBe("gemini-3.5-flash");
    expect(data.db).toBe("ok");
    expect(data.ok).toBe(true);
  });
});
