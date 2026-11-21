import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODEL, CHAT_CONTEXT_TURNS } from "@/lib/config";
import { chatSchema, firstIssueMessage } from "@/lib/schemas";

export const runtime = "nodejs";

const MODEL = GEMINI_MODEL;
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const SYSTEM_PROMPT =
  "You are Vox, a concise, friendly voice assistant. Your replies are spoken aloud, " +
  "so answer in short, natural spoken sentences (1-3 sentences unless asked for detail). " +
  "If asked a question you cannot answer, say so honestly.";

type HistoryTurn = { role: "user" | "assistant"; text: string };

// GET reports which brain is live so the client can label the session.
export async function GET() {
  return NextResponse.json({ engine: process.env.GEMINI_API_KEY ? "gemini" : "browser", model: MODEL });
}

// POST generates the spoken reply. Uses Gemini Flash when GEMINI_API_KEY is set
// (Vault), otherwise falls back to deterministic local responses.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
  const userText = parsed.data.userText;
  const history: HistoryTurn[] = parsed.data.history;

  const key = process.env.GEMINI_API_KEY;
  if (key) {
    const contents = [
      ...history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
      { role: "user", parts: [{ text: userText }] },
    ];
    try {
      const res = await fetch(`${BASE_URL}/models/${MODEL}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const reply = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("").trim();
        if (reply) return NextResponse.json({ reply, engine: "gemini" });
      } else {
        const detail = await res.text();
        console.error("Gemini generateContent failed", res.status, detail.slice(0, 300));
      }
    } catch (e) {
      console.error("Gemini generateContent error", e);
    }
  }

  // Fallback brain so the pipeline still works without a key or on upstream errors.
  const text = userText.toLowerCase();
  let reply: string;
  if (/^(hi|hello|hey)\b/.test(text)) reply = "Hello! I'm your voice assistant. What can I do for you?";
  else if (text.includes("time")) reply = `It's ${new Date().toLocaleTimeString()}.`;
  else if (text.includes("date") || text.includes("today")) reply = `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;
  else if (text.includes("your name")) reply = "I'm Vox, your voice assistant.";
  else if (text.includes("thank")) reply = "You're welcome!";
  else reply = `You said: ${userText}. I'm running without a Gemini key right now, so my replies are simple.`;

  return NextResponse.json({ reply, engine: "fallback" });
}
