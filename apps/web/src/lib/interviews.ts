// Server-side page data from services/api (dashboard, report, debug trace),
// mapped to the shapes the pages render. The browser makes every other call.
import { apiFor } from "./api-server";

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

export type ReportView = {
  iv: { id: string; role: string; level: string; status: string; createdAt: Date; report: ReportJson | null };
  qa: { id: string; questionText: string; answerText: string; evaluation: Evaluation | null }[];
};

export async function loadReportView(userId: string, id: string): Promise<ReportView | null> {
  const res = await apiFor(userId).GET("/v1/interviews/{interview_id}", { params: { path: { interview_id: id } } });
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

export async function loadDashboard(userId: string) {
  const api = apiFor(userId);
  const [s, t, i, q] = await Promise.all([
    api.GET("/v1/sessions"),
    api.GET("/v1/turns"),
    api.GET("/v1/interviews"),
    api.GET("/v1/interviews/scores"),
  ]);
  if (!s.data || !t.data || !i.data || !q.data) throw new Error("dashboard API failed");
  return {
    sessions: s.data.sessions.map((x) => ({ id: x.id, mode: x.mode, createdAt: new Date(x.created_at).toISOString() })),
    turns: t.data.turns.map((x) => ({
      sessionId: x.session_id,
      role: x.role,
      text: x.text,
      latencyMs: x.latency_ms ?? null,
      createdAt: new Date(x.created_at).toISOString(),
    })),
    interviews: i.data.interviews.map((x) => ({
      id: x.id,
      role: x.role,
      level: x.level,
      status: x.status,
      overall: x.overall ?? null,
      createdAt: new Date(x.created_at).toISOString(),
    })),
    qaScores: q.data.scores.map((x) => ({
      interviewId: x.interview_id,
      order: x.order,
      score: x.score ?? null,
      createdAt: new Date(x.created_at).toISOString(),
    })),
  };
}

export type StepView = { id: string; stepIndex: number; toolName: string; durationMs: number; input: unknown; output: unknown };

export async function loadAgentSteps(userId: string, interviewId: string): Promise<StepView[] | null> {
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
