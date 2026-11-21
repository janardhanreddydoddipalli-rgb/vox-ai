import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { POST as createPost } from "@/app/api/interviews/route";
import { GET as infoGet } from "@/app/api/interviews/[id]/route";
import { POST as endPost } from "@/app/api/interviews/[id]/end/route";
import { GET as pdfGet } from "@/app/api/interviews/[id]/report.pdf/route";
import { DELETE as deleteMe } from "@/app/api/me/delete/route";
import { loadDashboard, loadReportView } from "@/lib/interviews";
import { upsertUserByEmail } from "@/lib/db";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const IV = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id: IV }) };
const REPORT = { overall: 7, strengths: ["a"], gaps: ["b"], summary: "s", perQuestion: [] };
const DETAIL = {
  id: IV,
  role: "Backend",
  level: "mid",
  status: "complete",
  language: "hi",
  has_resume: true,
  current_question_index: 1,
  created_at: "2026-11-22T10:00:00Z",
  completed_at: "2026-11-22T10:30:00Z",
  report: REPORT,
  qa: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      order: 0,
      question_id: null,
      question: "What is an index?",
      answer: "A lookup structure.",
      evaluation: { score: 8, clarity: "c", depth: "d", correctness: "k", missing_points: [] },
      created_at: "2026-11-22T10:05:00Z",
    },
  ],
};

type Call = { method: string; url: string; body: FormData | string | null };
function stubApi(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string, init?: RequestInit) => {
      const req = typeof input === "string" ? new Request(input, init) : input;
      const ct = req.headers.get("content-type") ?? "";
      const body = req.method === "GET" || req.method === "DELETE" && !ct ? null : ct.includes("multipart") ? await req.formData() : await req.text();
      calls.push({ method: req.method, url: req.url, body });
      const key = `${req.method} ${new URL(req.url).pathname}`;
      const make = routes[key];
      if (!make) throw new Error(`unexpected API call ${key}`);
      return make();
    }),
  );
  return calls;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  process.env.API_JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.API_INTERNAL_URL = "http://api.test";
});

beforeEach(async () => {
  await resetDb();
  testAuth.asA();
  process.env.ROUTE_INTERVIEWS = "fastapi";
});

afterEach(() => {
  delete process.env.ROUTE_INTERVIEWS;
  delete process.env.ROUTE_TURNS;
  vi.unstubAllGlobals();
});

function form(fields: Record<string, string>, resume?: File) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (resume) fd.set("resume", resume);
  return new Request("http://localhost:3000/api/interviews", { method: "POST", body: fd }) as any;
}

describe("interview routes with ROUTE_INTERVIEWS=fastapi", () => {
  it("create forwards the form (renamed fields + résumé) and returns the id", async () => {
    const calls = stubApi({ "POST /v1/interviews": json(201, { id: IV }) });
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "cv.pdf", { type: "application/pdf" });
    const res = await createPost(form({ role: "Backend", level: "mid", language: "ta", jobDescription: "Postgres" }, pdf));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: IV });
    const sent = calls[0].body as FormData;
    expect([sent.get("role"), sent.get("level"), sent.get("language"), sent.get("job_description")]).toEqual(["Backend", "mid", "ta", "Postgres"]);
    expect((sent.get("resume") as File).name).toBe("cv.pdf");
  });

  it("create keeps the web's validation and maps API 400s", async () => {
    const calls = stubApi({ "POST /v1/interviews": json(400, { status: 400, detail: "Could not read text from that PDF" }) });
    expect((await createPost(form({ level: "mid" }))).status).toBe(400);
    expect(calls).toHaveLength(0);
    const res = await createPost(form({ role: "X", level: "mid" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Could not read text from that PDF" });
  });

  it("detail maps to the interview page's shape", async () => {
    stubApi({ [`GET /v1/interviews/${IV}`]: json(200, DETAIL) });
    expect(await (await infoGet({} as any, ctx)).json()).toEqual({
      id: IV,
      role: "Backend",
      level: "mid",
      status: "complete",
      questionCount: 1,
      hasResume: true,
      language: "hi",
      qa: [{ order: 0, question: "What is an index?", answer: "A lookup structure.", score: 8 }],
    });
  });

  it("end returns the report; 404 and 502 keep the web's contract", async () => {
    stubApi({ [`POST /v1/interviews/${IV}/end`]: json(200, { id: IV, report: REPORT }) });
    expect(await (await endPost({} as any, ctx)).json()).toEqual({ id: IV, report: REPORT });

    stubApi({ [`POST /v1/interviews/${IV}/end`]: json(404, { status: 404 }) });
    const missing = await endPost({} as any, ctx);
    expect([missing.status, await missing.json()]).toEqual([404, { error: "Interview not found" }]);

    stubApi({ [`POST /v1/interviews/${IV}/end`]: json(502, { status: 502 }) });
    const failed = await endPost({} as any, ctx);
    expect(failed.status).toBe(502);
  });

  it("report.pdf streams the API's bytes", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 test");
    stubApi({
      [`GET /v1/interviews/${IV}/report.pdf`]: () =>
        new Response(bytes, { headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="vox-interview-22222222.pdf"' } }),
    });
    const res = await pdfGet({} as any, ctx);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("vox-interview-22222222.pdf");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("delete my data forwards to DELETE /v1/me", async () => {
    stubApi({ "DELETE /v1/me": json(200, { sessions_deleted: 3 }) });
    expect(await (await deleteMe()).json()).toEqual({ ok: true, sessionsDeleted: 3 });
  });

  it("page loaders map the API data", async () => {
    process.env.ROUTE_TURNS = "fastapi";
    stubApi({
      [`GET /v1/interviews/${IV}`]: json(200, DETAIL),
      "GET /v1/sessions": json(200, { sessions: [{ id: "s-1", mode: "gemini", created_at: "2026-11-22T09:00:00Z" }] }),
      "GET /v1/turns": json(200, {
        sessions: ["s-1"],
        turns: [{ id: "t", session_id: "s-1", role: "user", text: "hi", latency_ms: null, stt_ms: null, first_token_ms: null, total_llm_ms: null, tts_start_ms: null, created_at: "2026-11-22T09:01:00Z" }],
      }),
      "GET /v1/interviews": json(200, { interviews: [{ id: IV, role: "Backend", level: "mid", status: "complete", language: "en", overall: 7, created_at: "2026-11-22T10:00:00Z" }] }),
      "GET /v1/interviews/scores": json(200, { scores: [{ interview_id: IV, order: 0, score: 8, created_at: "2026-11-22T10:05:00Z" }] }),
    });
    const user = await upsertUserByEmail("user-a@example.com");

    const view = await loadReportView(user!.id, IV);
    expect(view!.iv.report).toEqual(REPORT);
    expect(view!.qa[0]).toMatchObject({ questionText: "What is an index?", evaluation: { score: 8 } });

    const dash = await loadDashboard(user!.id);
    expect(dash.sessions).toEqual([{ id: "s-1", mode: "gemini", createdAt: "2026-11-22T09:00:00.000Z" }]);
    expect(dash.turns[0]).toEqual({ sessionId: "s-1", role: "user", text: "hi", latencyMs: null, createdAt: "2026-11-22T09:01:00.000Z" });
    expect(dash.interviews[0]).toMatchObject({ id: IV, overall: 7 });
    expect(dash.qaScores).toEqual([{ interviewId: IV, order: 0, score: 8, createdAt: "2026-11-22T10:05:00.000Z" }]);
  });
});
