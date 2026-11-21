// Interview-mode chat via services/api (ROUTE_AGENT=fastapi, M3). The API's SSE
// stream is passed through; the web's own in-stream messages for "not signed
// in" and "interview not found" are reproduced so the browser contract is unchanged.
import { apiFetch, apiErrorResponse } from "./api-server";

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" };

function offlineMessage(reason: string, text: string): Response {
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const body =
    event("meta", { engine: "offline", reason }) +
    event("token", { text }) +
    event("sentence", { text }) +
    event("done", { total_llm_ms: 0 });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

type AgentRequest = {
  userText: string;
  history: { role: "user" | "assistant"; text: string }[];
  interviewId?: string;
  interview?: { role: string; level: string };
};

export async function agentTurnViaApi(userId: string | null, req: AgentRequest, signal: AbortSignal): Promise<Response> {
  if (!userId) return offlineMessage("Sign in to use interview mode", "Please sign in to start an interview.");

  let interviewId = req.interviewId;
  if (!interviewId && req.interview) {
    const form = new FormData();
    form.set("role", req.interview.role);
    form.set("level", req.interview.level);
    const created = await apiFetch(userId, "/v1/interviews", { method: "POST", body: form, signal });
    if (created.status !== 201) return apiErrorResponse(created.status, "Not found", created.headers.get("retry-after"));
    interviewId = (await created.json()).id as string;
  }

  const upstream = await apiFetch(userId, `/v1/interviews/${encodeURIComponent(interviewId ?? "")}/turns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_text: req.userText, history: req.history }),
    signal,
  });
  if (upstream.status === 404 || upstream.status === 422) {
    return offlineMessage("Interview not found", "I couldn't find that interview.");
  }
  if (!upstream.ok || !upstream.body) {
    return apiErrorResponse(upstream.status, "Not found", upstream.headers.get("retry-after"));
  }
  return new Response(upstream.body, { status: 200, headers: SSE_HEADERS });
}
