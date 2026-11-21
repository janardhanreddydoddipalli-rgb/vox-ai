import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  ensureSession,
  addTurns,
  getTurnsForSessions,
  sessionIdsForUser,
  sessionOwnedBy,
  upsertUserByEmail,
  type Mode,
} from "@/lib/db";
import { turnsSchema, firstIssueMessage } from "@/lib/schemas";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Save turns for a session. The session is stamped with the signed-in user;
// anonymous (pre-auth) clients are rejected by middleware.
export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  const userId = session?.user?.email ? await userIdForEmail(session.user.email) : null;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRate(req, "turns", userId);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const parsed = turnsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssueMessage(parsed.error) }, { status: 400 });
  }
  const { sessionId, mode, turns } = parsed.data;
  await ensureSession(userId, sessionId, mode as Mode);
  await addTurns(turns.map((t) => ({ sessionId, role: t.role, text: t.text, latencyMs: t.latencyMs })));
  const saved = await getTurnsForSessions([sessionId]);
  return NextResponse.json({ ok: true, turns: saved });
}

// Read history: only the signed-in user's own sessions, ever.
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.email ? await userIdForEmail(session.user.email) : null;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const owned = await sessionIdsForUser(userId);
  const url = new URL(req.url);
  const wanted = url.searchParams.get("sessionId");
  if (wanted) {
    if (!(await sessionOwnedBy(wanted, userId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ sessionId: wanted, turns: await getTurnsForSessions([wanted]) });
  }
  const turns = await getTurnsForSessions(owned);
  return NextResponse.json({ sessions: owned, turns });
}

async function userIdForEmail(email: string): Promise<string | null> {
  const user = await upsertUserByEmail(email);
  return user?.id ?? null;
}
