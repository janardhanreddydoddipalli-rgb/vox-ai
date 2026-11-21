import { NextRequest, NextResponse } from "next/server";
import { ensureSession, addTurn, getTurns, listSessions } from "@/lib/db";
import { turnsSchema, firstIssueMessage } from "@/lib/schemas";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const limited = checkRate(req, "turns");
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = turnsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
  const { sessionId, mode, turns } = parsed.data;
  ensureSession(sessionId, mode);
  for (const t of turns) {
    addTurn(sessionId, t.role, t.text, t.latencyMs);
  }
  return NextResponse.json({ ok: true, turns: getTurns(sessionId) });
}

// History is not public until auth exists (Phase 2): require the admin token.
export async function GET(req: NextRequest) {
  const token = process.env.ADMIN_TOKEN;
  const provided = req.headers.get("x-admin-token");
  if (!token || !provided || provided !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ sessions: listSessions() });
}
