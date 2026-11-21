// Records Gemini Live token usage against the daily cost guard. The live
// session runs browser ↔ Gemini directly, so the browser forwards each
// usageMetadata frame here.
//
// Trust: counts are client-reported. They are bounded per report and the
// session's hard cap is the ephemeral token's expireTime; a server-side
// duration floor keyed by a server-issued voice session id comes with the
// voice_sessions table in M3.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { upsertUserByEmail } from "@/lib/db";
import { loadInterview } from "@/agent/state";
import { checkDailyBudget, recordTokenUsage } from "@/lib/cost-guard";
import { setSentryUser } from "@/lib/observability";

export const runtime = "nodejs";

// Upper bound per report: far above one live turn, low enough that a single
// forged report can't poison the ledger with absurd numbers.
const MAX_TOKENS_PER_REPORT = 1_000_000;

const bodySchema = z.object({
  interviewId: z.string().uuid().nullable().default(null),
  promptTokens: z.number().int().min(0).max(MAX_TOKENS_PER_REPORT),
  responseTokens: z.number().int().min(0).max(MAX_TOKENS_PER_REPORT),
});

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid usage report" }, { status: 400 });
  const { interviewId, promptTokens, responseTokens } = parsed.data;

  const user = await upsertUserByEmail(session.user.email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  setSentryUser(user.id);

  const limited = await checkRate(req, "voice-usage", user.id, 120);
  if (limited) return limited;

  if (interviewId && !(await loadInterview(interviewId, user.id))) {
    return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  }

  await recordTokenUsage(user.id, promptTokens, responseTokens);
  const budget = await checkDailyBudget(user.id);
  return NextResponse.json({ ok: true, budgetExceeded: !budget.allowed, message: budget.message });
}
