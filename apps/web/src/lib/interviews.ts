// Interviews, reports and account data via services/api (ROUTE_INTERVIEWS=fastapi, M3),
// mapped back to the shapes the web routes and pages already use.
import type { components } from "@vox/api-client";
import {
  getInterview,
  listInterviewQa,
  listInterviews,
  latestQaScores,
  listSessions,
  getTurnsForSessions,
  getAgentSteps,
} from "@/lib/db";
import { apiFor, apiFetch, apiErrorResponse } from "./api-server";
import { routeTarget } from "./route-flags";

type Detail = components["schemas"]["InterviewDetail"];
export type Evaluation = {
  score?: number;
  clarity?: string;
  depth?: string;
  correctness?: string;
  missing_points?: string[];
};
export type ReportJson = {
  overall: number;
  strengths: string[];
  gaps: string[];
  summary: string;
  perQuestion?: { question: string; score: number; better_answer: string }[];
};

const viaApi = () => routeTarget("INTERVIEWS") === "fastapi";
const NOT_FOUND = "Interview not found";

// --- route handlers (fastapi mode) ---------------------------------------------------

export async function createInterviewViaApi(userId: string, form: FormData): Promise<Response> {
  const body = new FormData();
  for (const key of ["role", "level", "language"] as const) {
    const v = form.get(key);
    if (typeof v === "string") body.set(key, v);
  }
  const jd = form.get("jobDescription");
  if (typeof jd === "string" && jd.trim()) body.set("job_description", jd);
  const file = form.get("resume");
  if (file instanceof File && file.size > 0) body.set("resume", file, file.name);

  const res = await apiFetch(userId, "/v1/interviews", { method: "POST", body });
  if (res.status === 201) return Response.json({ id: (await res.json()).id }, { status: 201 });
  if (res.status === 400 || res.status === 422) {
    const problem = await res.json().catch(() => null);
    return Response.json({ error: problem?.detail ?? "Invalid form" }, { status: 400 });
  }
  return apiErrorResponse(res.status, NOT_FOUND, res.headers.get("retry-after"));
}

function toInfo(d: Detail) {
  return {
    id: d.id,
    role: d.role,
    level: d.level,
    status: d.status,
    questionCount: d.qa.length,
    hasResume: d.has_resume,
    language: d.language,
    qa: d.qa.map((q) => ({
      order: q.order,
      question: q.question,
      answer: q.answer,
      score: (q.evaluation as Evaluation | null)?.score ?? null,
    })),
  };
}

export async function interviewInfoViaApi(userId: string, id: string): Promise<Response> {
  const res = await apiFor(userId).GET("/v1/interviews/{interview_id}", {
    params: { path: { interview_id: id } },
  });
  if (res.data) return Response.json(toInfo(res.data));
  return apiErrorResponse(res.response.status === 422 ? 404 : res.response.status, NOT_FOUND);
}

export async function endInterviewViaApi(userId: string, id: string): Promise<Response> {
  const res = await apiFor(userId).POST("/v1/interviews/{interview_id}/end", {
    params: { path: { interview_id: id } },
  });
  if (res.data) return Response.json({ id: res.data.id, report: res.data.report });
  if (res.response.status === 502) {
    return Response.json({ error: "Could not generate the report. Please try again." }, { status: 502 });
  }
  return apiErrorResponse(res.response.status === 422 ? 404 : res.response.status, NOT_FOUND);
}

export async function reportPdfViaApi(userId: string, id: string): Promise<Response> {
  const res = await apiFetch(userId, `/v1/interviews/${encodeURIComponent(id)}/report.pdf`);
  if (res.status !== 200) return apiErrorResponse(res.status === 422 ? 404 : res.status, "Report not found");
  return new Response(await res.arrayBuffer(), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": res.headers.get("content-disposition") ?? "attachment",
    },
  });
}

export async function deleteMeViaApi(userId: string): Promise<Response> {
  const res = await apiFor(userId).DELETE("/v1/me");
  if (!res.data) return apiErrorResponse(res.response.status);
  return Response.json({ ok: true, sessionsDeleted: res.data.sessions_deleted });
}

// --- page loaders (either mode) ----------------------------------------------------

export type ReportView = {
  iv: { id: string; role: string; level: string; status: string; createdAt: Date; report: ReportJson | null };
  qa: { id: string; questionText: string; answerText: string; evaluation: Evaluation | null }[];
};

export async function loadReportView(userId: string, id: string): Promise<ReportView | null> {
  if (viaApi()) {
    const res = await apiFor(userId).GET("/v1/interviews/{interview_id}", {
      params: { path: { interview_id: id } },
    });
    if (!res.data) {
      if (res.response.status === 404 || res.response.status === 422) return null;
      throw new Error(`interviews API failed: ${res.response.status}`);
    }
    const d = res.data;
    return {
      iv: {
        id: d.id,
        role: d.role,
        level: d.level,
        status: d.status,
        createdAt: new Date(d.created_at),
        report: (d.report as ReportJson | null) ?? null,
      },
      qa: d.qa.map((q) => ({
        id: q.id,
        questionText: q.question,
        answerText: q.answer,
        evaluation: (q.evaluation as Evaluation | null) ?? null,
      })),
    };
  }
  const iv = await getInterview(id, userId);
  if (!iv) return null;
  const qa = await listInterviewQa(id);
  return {
    iv: { id: iv.id, role: iv.role, level: iv.level, status: iv.status, createdAt: iv.createdAt, report: iv.report ?? null },
    qa: qa.map((q) => ({ id: q.id, questionText: q.questionText, answerText: q.answerText, evaluation: q.evaluation ?? null })),
  };
}

export async function loadDashboard(userId: string) {
  const turnsViaApi = routeTarget("TURNS") === "fastapi";
  const api = apiFor(userId);

  const [sessions, turns] = turnsViaApi
    ? await (async () => {
        const [s, t] = await Promise.all([api.GET("/v1/sessions"), api.GET("/v1/turns")]);
        if (!s.data || !t.data) throw new Error("sessions/turns API failed");
        return [
          s.data.sessions.map((x) => ({ id: x.id, mode: x.mode, createdAt: new Date(x.created_at).toISOString() })),
          t.data.turns.map((x) => ({
            sessionId: x.session_id,
            role: x.role,
            text: x.text,
            latencyMs: x.latency_ms ?? null,
            createdAt: new Date(x.created_at).toISOString(),
          })),
        ] as const;
      })()
    : await (async () => {
        const s = await listSessions(userId);
        const t = await getTurnsForSessions(s.map((x) => x.id));
        return [
          s.map((x) => ({ id: x.id, mode: x.mode, createdAt: x.createdAt.toISOString() })),
          t.map((x) => ({
            sessionId: x.sessionId,
            role: x.role,
            text: x.text,
            latencyMs: x.latencyMs,
            createdAt: x.createdAt.toISOString(),
          })),
        ] as const;
      })();

  const [interviews, qaScores] = viaApi()
    ? await (async () => {
        const [i, s] = await Promise.all([api.GET("/v1/interviews"), api.GET("/v1/interviews/scores")]);
        if (!i.data || !s.data) throw new Error("interviews API failed");
        return [
          i.data.interviews.map((x) => ({
            id: x.id,
            role: x.role,
            level: x.level,
            status: x.status,
            overall: x.overall ?? null,
            createdAt: new Date(x.created_at).toISOString(),
          })),
          s.data.scores.map((x) => ({
            interviewId: x.interview_id,
            order: x.order,
            score: x.score ?? null,
            createdAt: new Date(x.created_at).toISOString(),
          })),
        ] as const;
      })()
    : await (async () => {
        const i = await listInterviews(userId);
        const s = await latestQaScores(userId);
        return [
          i.map((x) => ({
            id: x.id,
            role: x.role,
            level: x.level,
            status: x.status,
            overall: x.report?.overall ?? null,
            createdAt: x.createdAt.toISOString(),
          })),
          s.map((x) => ({
            interviewId: x.interviewId,
            order: x.order,
            score: x.evaluation?.score ?? null,
            createdAt: x.createdAt.toISOString(),
          })),
        ] as const;
      })();

  return { sessions: [...sessions], turns: [...turns], interviews: [...interviews], qaScores: [...qaScores] };
}

export type StepView = { id: string; stepIndex: number; toolName: string; durationMs: number; input: unknown; output: unknown };

export async function loadAgentSteps(userId: string, interviewId: string): Promise<StepView[] | null> {
  if (viaApi()) {
    const res = await apiFor(userId).GET("/v1/interviews/{interview_id}/steps", {
      params: { path: { interview_id: interviewId } },
    });
    if (!res.data) return null;
    return res.data.steps.map((s) => ({
      id: s.id,
      stepIndex: s.step_index,
      toolName: s.tool_name,
      durationMs: s.duration_ms,
      input: s.input,
      output: s.output,
    }));
  }
  if (!(await getInterview(interviewId, userId))) return null;
  return (await getAgentSteps(interviewId)).map((s) => ({
    id: s.id,
    stepIndex: s.stepIndex,
    toolName: s.toolName,
    durationMs: s.durationMs,
    input: s.input,
    output: s.output,
  }));
}
