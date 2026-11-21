import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODEL, CHAT_CONTEXT_TURNS } from "@/lib/config";
import { chatSchema, firstIssueMessage } from "@/lib/schemas";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";
import { upsertUserByEmail } from "@/lib/db";
import { listMemoriesByKind } from "@/lib/db/repository";
import { runAgentLoop, type LoopMessage } from "@/agent/loop";
import { INTERVIEWER_SYSTEM_PROMPT } from "@/agent/prompt";
import { languageDirective } from "@/lib/languages";
import { startInterview, loadInterview } from "@/agent/state";
import { setSentryUser, captureVoxError } from "@/lib/observability";
import { startTurnTrace } from "@/lib/tracing";
import { checkDailyBudget, recordTokenUsage } from "@/lib/cost-guard";
import type { LoopResult } from "@/agent/loop";
import "@/agent/tools/all";
import { routeTarget } from "@/lib/route-flags";
import { apiFetch, apiErrorResponse } from "@/lib/api-server";

export const runtime = "nodejs";

async function userIdForEmail(email: string): Promise<string | null> {
  const user = await upsertUserByEmail(email);
  return user?.id ?? null;
}

const MODEL = GEMINI_MODEL;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const SYSTEM_PROMPT =
  "You are Vox, a concise, friendly voice assistant. Your replies are spoken aloud, " +
  "so answer in short, natural spoken sentences (1-3 sentences unless asked for detail). " +
  "If asked a question you cannot answer, say so honestly.";

type HistoryTurn = { role: "user" | "assistant"; text: string };

// Server-Sent Events to the client: token | sentence | done | error.
function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Split streaming text into complete sentences (keeps the trailing delimiter).
function sentences(chunk: string): string[] {
  return chunk.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
}

// POST-only: generates the spoken reply as an SSE stream. Uses Gemini
// streamGenerateContent when GEMINI_API_KEY is set, otherwise falls back to
// deterministic local responses. Engine/model info lives at GET /api/health.
export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  const userId = session?.user?.email ? await userIdForEmail(session.user.email) : null;
  setSentryUser(userId);

  const body = await req.json().catch(() => null);
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }

  // Plain (non-interview) chat is served by services/api when ROUTE_CHAT=fastapi:
  // its SSE stream is passed through unchanged; the API rate-limits and meters it.
  const interviewMode = Boolean(parsed.data.interview || parsed.data.interviewId);
  if (!interviewMode && routeTarget("CHAT") === "fastapi") {
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const upstream = await apiFetch(userId, "/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_text: parsed.data.userText, history: parsed.data.history }),
      signal: req.signal,
    });
    if (!upstream.ok || !upstream.body) {
      if (upstream.status === 422) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
      return apiErrorResponse(upstream.status, "Not found", upstream.headers.get("retry-after"));
    }
    return new NextResponse(upstream.body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
    });
  }

  const limited = await checkRate(req, "chat", userId);
  if (limited) return limited;
  const userText = parsed.data.userText;
  const history: HistoryTurn[] = parsed.data.history;

  const key = process.env.GEMINI_API_KEY;
  const startedAt = Date.now();

  // Aborts the upstream Gemini call when the client disconnects (response
  // stream cancelled) or the incoming request is aborted.
  const upstream = new AbortController();
  req.signal?.addEventListener("abort", () => upstream.abort());

  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      upstream.abort();
    },
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed || upstream.signal.aborted) return;
        try {
          controller.enqueue(sse(event, data));
        } catch {
          closed = true;
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by cancel */
        }
      };

      if (parsed.data.interview || parsed.data.interviewId) {
        // ---- Agent (interview) mode: Gemini function calling loop. --------
        if (!userId) {
          send("meta", { engine: "offline", reason: "Sign in to use interview mode" });
          send("token", { text: "Please sign in to start an interview." });
          send("sentence", { text: "Please sign in to start an interview." });
          send("done", { total_llm_ms: 0 });
          finish();
          return;
        }
        const iv = parsed.data.interview;
        const interview = iv
          ? await startInterview(userId, iv.role, iv.level)
          : await loadInterview(parsed.data.interviewId!, userId);
        if (!interview) {
          send("meta", { engine: "offline", reason: "Interview not found" });
          send("token", { text: "I couldn't find that interview." });
          send("sentence", { text: "I couldn't find that interview." });
          send("done", { total_llm_ms: 0 });
          finish();
          return;
        }
        // Load the candidate's known weaknesses so the interviewer drills
        // them first. Best-effort: an empty memory bank changes nothing.
        let systemPrompt = INTERVIEWER_SYSTEM_PROMPT + languageDirective(interview.language ?? "en");
        try {
          const weaknesses = await listMemoriesByKind(userId, "weakness", 5);
          if (weaknesses.length > 0) {
            const list = weaknesses.map((w) => `- ${w.text}`).join("\n");
            systemPrompt +=
              "\n\nThis candidate's known weak areas from past interviews (drill these first — " +
              "pass them as focus_topics to get_question, one topic per call):\n" + list;
          }
        } catch (memErr) {
          console.error("memory load failed", memErr);
        }
        send("meta", {
          engine: "gemini",
          model: MODEL,
          mode: "interview",
          interview_id: interview.id,
          first_token_ms: Date.now() - startedAt,
        });
        try {
          const loopHistory: LoopMessage[] = history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", text: t.text }));
          const budget = await checkDailyBudget(userId);
        if (!budget.allowed) {
          send("done", { total_llm_ms: 0, budget_exceeded: true, message: budget.message });
          finish();
          return;
        }
        const trace = startTurnTrace({ userId, interviewId: interview.id, sessionId: interview.id, provider: "text-gemini" });
          let result: LoopResult;
          try {
            result = await runAgentLoop(
              userText,
              loopHistory,
              systemPrompt,
              {
                onToken: (t) => send("token", { text: t }),
                onSentence: (s) => send("sentence", { text: s }),
              },
              { userId, interviewId: interview.id },
              upstream.signal,
            );
          } catch (loopErr) {
            trace.fail(loopErr);
            throw loopErr;
          }
          await trace.finish({
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            latencyMs: result.llmMs,
            toolSteps: result.steps,
            hitStepLimit: result.hitStepLimit,
          });
          await recordTokenUsage(userId, result.tokensIn, result.tokensOut).catch((e) => console.error("usage record failed", e));
          for (const step of result.steps) send("tool", { name: step.toolName, step: step.stepIndex, duration_ms: step.durationMs });
          send("done", {
            total_llm_ms: Date.now() - startedAt,
            interview_id: interview.id,
            tool_steps: result.steps.length,
            hit_step_limit: result.hitStepLimit,
            tokens_in: result.tokensIn,
            tokens_out: result.tokensOut,
          });
          finish();
          return;
        } catch (e) {
          if ((e as any)?.name === "AbortError" || upstream.signal.aborted) {
            finish();
            return;
          }
          console.error("Agent loop error", e);
          captureVoxError(e, { route: "/api/chat", mode: "interview" });
          send("error", { message: "The interviewer hit a problem. Please try again." });
          finish();
          return;
        }
      }

      if (key) {
        const contents = [
          ...history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
          { role: "user", parts: [{ text: userText }] },
        ];
        try {
          const res = await fetch(`${BASE_URL}/models/${MODEL}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents,
              generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
            }),
            signal: upstream.signal,
          });
          if (res.ok && res.body) {
            let first = true;
            let full = "";
            let carry = "";
            const reader = res.body.getReader();
            const onAbort = () => {
              reader.cancel().catch(() => {});
            };
            upstream.signal.addEventListener("abort", onAbort);
            const decoder = new TextDecoder();
            let buf = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";
                for (const line of lines) {
                  if (!line.startsWith("data: ")) continue;
                  let evt: any;
                  try {
                    evt = JSON.parse(line.slice(6));
                  } catch {
                    continue;
                  }
                  const piece: string = evt?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
                  if (!piece) continue;
                  if (first) {
                    first = false;
                    send("meta", { engine: "gemini", model: MODEL, first_token_ms: Date.now() - startedAt });
                  }
                  full += piece;
                  send("token", { text: piece });
                  carry += piece;
                  const parts = sentences(carry);
                  carry = parts.pop() ?? "";
                  for (const s of parts) send("sentence", { text: s.trim() });
                }
              }
              if (carry.trim()) send("sentence", { text: carry.trim() });
              if (full.trim()) {
                send("done", { total_llm_ms: Date.now() - startedAt });
                finish();
                return;
              }
              console.error("Gemini stream returned no content");
            } catch (e: any) {
              if (e?.name === "AbortError" || upstream.signal.aborted) {
                finish();
                return;
              }
              console.error("Gemini stream error", e);
              if (first) {
                // no token sent yet — fall through to offline below
              } else {
                send("error", { message: "The reply was cut off. Please try again." });
                finish();
                return;
              }
            }
          } else {
            const detail = res.ok ? "no body" : (await res.text().catch(() => "")).slice(0, 300);
            console.error("Gemini streamGenerateContent failed", res.status, detail);
          }
        } catch (e) {
          if ((e as any)?.name !== "AbortError") console.error("Gemini stream error", e);
        }
      }

      // Offline fallback: no key, upstream failure, or stream died before the
      // first token. Marked via meta.engine="offline" so the UI shows a badge.
      const reason = key ? "Gemini upstream failed" : "GEMINI_API_KEY not configured";
      // Never log transcript text — ids and lengths only.
      console.warn(`[chat] serving offline fallback (${reason}) user=${userId ?? "anon"} chars=${userText.length}`);
      const text = userText.toLowerCase();
      let reply: string;
      if (/^(hi|hello|hey)\b/.test(text)) reply = "Hello! I'm your voice assistant. What can I do for you?";
      else if (text.includes("time")) reply = `It's ${new Date().toLocaleTimeString()}.`;
      else if (text.includes("date") || text.includes("today"))
        reply = `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;
      else if (text.includes("your name")) reply = "I'm Vox, your voice assistant.";
      else if (text.includes("thank")) reply = "You're welcome!";
      else reply = `You said: ${userText}. I'm running without a Gemini key right now, so my replies are simple.`;

      send("meta", { engine: "offline", reason });
      // Sentence-split so TTS queues each part as it "streams".
      const offParts = sentences(reply);
      const offCarry = offParts.pop() ?? reply;
      for (const s of offParts) send("sentence", { text: s.trim() });
      if (offCarry.trim()) send("sentence", { text: offCarry.trim() });
      send("done", { total_llm_ms: Date.now() - startedAt });
      finish();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
