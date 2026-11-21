// Playground turns via services/api (ROUTE_TURNS=fastapi, M3). Maps between the
// web's camelCase contract and the API's snake_case, so the browser is unchanged.
import type { components } from "@vox/api-client";
import type { TurnsRequest } from "./schemas";
import { apiFor, apiErrorResponse } from "./api-server";

type ApiTurn = components["schemas"]["Turn"];

function toWebTurn(t: ApiTurn) {
  return {
    id: t.id,
    sessionId: t.session_id,
    role: t.role,
    text: t.text,
    latencyMs: t.latency_ms ?? null,
    sttMs: t.stt_ms ?? null,
    firstTokenMs: t.first_token_ms ?? null,
    totalLlmMs: t.total_llm_ms ?? null,
    ttsStartMs: t.tts_start_ms ?? null,
    createdAt: new Date(t.created_at).toISOString(),
  };
}

export async function saveTurnsViaApi(userId: string, req: TurnsRequest): Promise<Response> {
  const res = await apiFor(userId).POST("/v1/sessions/{session_id}/turns", {
    params: { path: { session_id: req.sessionId } },
    body: {
      mode: req.mode,
      turns: req.turns.map((t) => ({
        role: t.role,
        text: t.text,
        latency_ms: t.latencyMs,
        stt_ms: t.sttMs,
        first_token_ms: t.firstTokenMs,
        total_llm_ms: t.totalLlmMs,
        tts_start_ms: t.ttsStartMs,
      })),
    },
  });
  if (res.data) return Response.json({ ok: true, turns: res.data.turns.map(toWebTurn) });
  if (res.response.status === 422) return Response.json({ error: "Invalid request body" }, { status: 400 });
  return apiErrorResponse(res.response.status, "Not found", res.response.headers.get("retry-after"));
}

export async function readTurnsViaApi(userId: string, sessionId: string | null): Promise<Response> {
  const api = apiFor(userId);
  if (sessionId) {
    const res = await api.GET("/v1/sessions/{session_id}/turns", { params: { path: { session_id: sessionId } } });
    if (res.data) return Response.json({ sessionId: res.data.session_id, turns: res.data.turns.map(toWebTurn) });
    // A session id the API can't route (unsafe characters) can't be one of ours either.
    return apiErrorResponse(res.response.status === 422 ? 404 : res.response.status, "Not found");
  }
  const res = await api.GET("/v1/turns");
  if (!res.data) return apiErrorResponse(res.response.status);
  return Response.json({ sessions: res.data.sessions, turns: res.data.turns.map(toWebTurn) });
}
