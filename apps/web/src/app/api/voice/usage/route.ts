// Records Gemini Live token usage against the daily cost guard. The live
// session runs browser ↔ Gemini directly, so the browser forwards each
// usageMetadata frame here.
//
// Trust: counts are client-reported. They are bounded per report and the
// session's hard cap is the ephemeral token's expireTime. With
// ROUTE_VOICE=fastapi they are keyed by the server-issued voice session and
// kept per session for reconciliation (docs/verification.md Q1).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { upsertUserByEmail } from "@/lib/db";
import { loadInterview } from "@/agent/state";
import { checkDailyBudget, recordTokenUsage } from "@/lib/cost-guard";
import { setSentryUser } from "@/lib/observability";
import { routeTarget } from "@/lib/route-flags";
import { voiceUsageViaApi } from "@/lib/voice";

export const runtime = "nodejs";

// Upper bound per report: far above one live turn, low enough that a single
// forged report can't poison the ledger with absurd numbers.
const MAX_TOKENS_PER_REPORT = 1_000_000;

const bodySchema = z.object({
  interviewId: z.string().uuid().nullable().default(null),
  sessionId: z.string().uuid().optional(),
  promptTokens: z.number().int().min(0).max(MAX_TOKENS_PER_REPORT),
  responseTokens: z.number().int().min(0).max(MAX_TOKENS_PER_REPORT),
});

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid usage report" }, { status: 400 });
  const { interviewId, sessionId, promptTokens, responseTokens } = parsed.data;

  const user = await upsertUserByEmail(session.user.email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  setSentryUser(user.id);

  // services/api applies the same per-user limit itself when it serves the route.
  if (routeTarget("VOICE") === "fastapi") {
    if (!sessionId) return NextResponse.json({ error: "Invalid usage report" }, { status: 400 });
    return voiceUsageViaApi(user.id, { sessionId, promptTokens, responseTokens });
  }

  const limited = await checkRate(req, "voice-usage", user.id, 120);
  if (limited) return limited;

  if (interviewId && !(await loadInterview(interviewId, user.id))) {
    return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  }

  await recordTokenUsage(user.id, promptTokens, responseTokens);
  const budget = await checkDailyBudget(user.id);
  return NextResponse.json({ ok: true, budgetExceeded: !budget.allowed, message: budget.message });
}
