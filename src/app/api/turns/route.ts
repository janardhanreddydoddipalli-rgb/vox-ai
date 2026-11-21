import { NextRequest, NextResponse } from "next/server";
import { ensureSession, addTurn, getTurns, listSessions } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.sessionId !== "string" || !Array.isArray(body.turns)) {
    return NextResponse.json({ error: "sessionId and turns required" }, { status: 400 });
  }
  const mode = body.mode === "gemini" ? "gemini" : "browser";
  ensureSession(body.sessionId, mode);
  for (const t of body.turns) {
    if (t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim()) {
      addTurn(body.sessionId, t.role, t.text.trim().slice(0, 5000), Number.isFinite(t.latencyMs) ? t.latencyMs : undefined);
    }
  }
  return NextResponse.json({ ok: true, turns: getTurns(body.sessionId) });
}

export async function GET() {
  return NextResponse.json({ sessions: listSessions() });
}
