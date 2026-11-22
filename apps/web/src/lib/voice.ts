// Live voice via services/api (ROUTE_VOICE=fastapi, M3). The API issues a voice
// session id that fixes the user and interview; tool calls and usage reports are
// keyed by it, and a retried call_id replays the stored result. The browser
// contract stays the web's: camelCase fields and { ok, result | error } bodies.
import type { components, Problem } from "@vox/api-client";
import { apiFor, apiErrorResponse } from "./api-server";

type Language = components["schemas"]["VoiceSessionIn"]["language"];

// The API's problem details use the web's own error strings, so they pass through.
function errorResponse(response: Response, problem: unknown, fallback: string, invalid: string) {
  const p = problem as Problem | undefined;
  if (response.status === 422) return Response.json({ error: invalid }, { status: 400 });
  if (response.status === 429 && p?.code === "budget_exceeded") {
    return Response.json({ error: "budget_exceeded", message: p.detail }, { status: 429 });
  }
  if ([404, 409, 410, 502, 503].includes(response.status)) {
    return Response.json({ error: p?.detail ?? fallback }, { status: response.status });
  }
  return apiErrorResponse(response.status, fallback, response.headers.get("retry-after"));
}

export async function createVoiceSessionViaApi(
  userId: string,
  body: { interviewId?: string | null; language?: string },
): Promise<Response> {
  const { data, error, response } = await apiFor(userId).POST("/v1/voice/sessions", {
    body: { interview_id: body.interviewId ?? null, language: (body.language ?? null) as Language },
  });
  if (!data) return errorResponse(response, error, "Interview not found", "Unsupported language");
  return Response.json({
    sessionId: data.session_id,
    token: data.token,
    model: data.model,
    systemInstruction: data.system_instruction,
    tools: data.tools,
    expiresInSec: data.expires_in_sec,
  });
}

export async function voiceToolViaApi(
  userId: string,
  call: { sessionId: string; callId: string; name: string; args: Record<string, unknown> },
): Promise<Response> {
  const { data, error, response } = await apiFor(userId).POST("/v1/voice/sessions/{session_id}/tool-calls", {
    params: { path: { session_id: call.sessionId } },
    body: { call_id: call.callId, name: call.name, args: call.args },
  });
  if (!data) return errorResponse(response, error, "Voice session not found", "Invalid tool call");
  return Response.json(
    data.ok ? { ok: true, result: data.result ?? { ok: true } } : { ok: false, error: data.error, message: data.message },
  );
}

export async function voiceUsageViaApi(
  userId: string,
  report: { sessionId: string; promptTokens: number; responseTokens: number },
): Promise<Response> {
  const { data, error, response } = await apiFor(userId).POST("/v1/voice/sessions/{session_id}/usage", {
    params: { path: { session_id: report.sessionId } },
    body: { prompt_tokens: report.promptTokens, response_tokens: report.responseTokens },
  });
  if (!data) return errorResponse(response, error, "Voice session not found", "Invalid usage report");
  return Response.json({ ok: true, budgetExceeded: data.budget_exceeded, message: data.message ?? null });
}
