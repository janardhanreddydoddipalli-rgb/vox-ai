// One stop for starting a live voice session (Phase 6): mints an ephemeral
// Live API token and returns the tool declarations and system prompt the
// client must put in the setup frame. GEMINI_API_KEY never leaves the server.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { upsertUserByEmail } from "@/lib/db";
import { checkDailyBudget } from "@/lib/cost-guard";
import { GEMINI_LIVE_MODEL } from "@/lib/config";
import { setSentryUser, captureVoxError } from "@/lib/observability";
import { INTERVIEWER_SYSTEM_PROMPT } from "@/agent/prompt";
import { functionDeclarations } from "@/agent/loop";
// Registers the agent tools in this route's own module graph; without it the live
// session declares no tools (each route runs as its own function on Vercel).
import "@/agent/tools/all";
import { isLanguageCode, languageDirective } from "@/lib/languages";
import { routeTarget } from "@/lib/route-flags";
import { createVoiceSessionViaApi } from "@/lib/voice";
import { z } from "zod";

const bodySchema = z.object({
  language: z.string().refine(isLanguageCode).optional(),
  // Binds the session to this interview (ROUTE_VOICE=fastapi); ownership is checked there.
  interviewId: z.string().uuid().nullable().optional(),
});

export const runtime = "nodejs";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// Ephemeral token lifetimes: usable for new sessions for 2 minutes; the token
// itself stays valid 30 minutes (a connected session keeps streaming).
const SESSION_WINDOW_MINUTES = 2;
const TOKEN_LIFETIME_MINUTES = 30;
// Own bucket: each mint starts one live session (plus reconnects), so a
// handful per minute is plenty; each token is a paid session.
const VOICE_SESSION_LIMIT = 10;

function isoPlus(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await upsertUserByEmail(session.user.email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  setSentryUser(user.id);

  // Language is optional, but when present it must be a supported code: it is
  // interpolated into the system prompt, so free text is never accepted.
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Unsupported language" }, { status: 400 });
  const { language } = parsed.data;

  // services/api applies the same rate limit and budget check itself.
  if (routeTarget("VOICE") === "fastapi") return createVoiceSessionViaApi(user.id, parsed.data);

  const limit = await checkRate(req, "voice-session", user.id, VOICE_SESSION_LIMIT);
  if (limit) return limit;

  const budget = await checkDailyBudget(user.id);
  if (!budget.allowed) {
    return NextResponse.json({ error: "budget_exceeded", message: budget.message }, { status: 429 });
  }

  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    return NextResponse.json({ error: "Voice service is not configured" }, { status: 503 });
  }

  const systemInstruction =
    INTERVIEWER_SYSTEM_PROMPT +
    (language ? languageDirective(language) : "") +
    "\n\nYou are on a live voice call: keep replies to one or two spoken sentences, never use lists, markdown or emoji, and spell out numbers and code naturally for speech.";

  const res = await fetch(`${BASE_URL}/auth_tokens`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: isoPlus(TOKEN_LIFETIME_MINUTES),
      newSessionExpireTime: isoPlus(SESSION_WINDOW_MINUTES),
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    console.error("ephemeral token mint failed", res.status, await res.text().catch(() => ""));
    captureVoxError(new Error(`Ephemeral token mint failed: ${res.status}`), { route: "/api/voice/session" });
    return NextResponse.json({ error: "Could not start live voice" }, { status: 502 });
  }
  const data = await res.json();

  return NextResponse.json({
    token: data.name,
    model: GEMINI_LIVE_MODEL,
    systemInstruction,
    tools: functionDeclarations(),
    expiresInSec: TOKEN_LIFETIME_MINUTES * 60,
  });
}
