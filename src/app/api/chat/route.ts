import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODEL, CHAT_CONTEXT_TURNS } from "@/lib/config";
import { chatSchema, firstIssueMessage } from "@/lib/schemas";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { auth } from "@/lib/auth";
import { upsertUserByEmail } from "@/lib/db";

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
  const limited = await checkRate(req, "chat", userId);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
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
      console.warn(`[chat] serving offline fallback (${reason}) for: ${userText.slice(0, 80)}`);
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
