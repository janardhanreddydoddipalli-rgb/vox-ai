// One stop for starting a live voice session (Phase 6): mints an ephemeral
// Live API token and returns the tool declarations and system prompt the
// client must put in the setup frame. GEMINI_API_KEY never leaves the server.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { GEMINI_LIVE_MODEL } from "@/lib/config";
import { INTERVIEWER_SYSTEM_PROMPT } from "@/agent/prompt";
import { functionDeclarations } from "@/agent/loop";

export const runtime = "nodejs";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// Ephemeral token lifetimes: usable for new sessions for 2 minutes; the token
// itself stays valid 30 minutes (a connected session keeps streaming).
const SESSION_WINDOW_MINUTES = 2;
const TOKEN_LIFETIME_MINUTES = 30;

function isoPlus(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await checkRate(req, "chat", session.user.email);
  if (limit) return limit;

  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    return NextResponse.json({ error: "Voice service is not configured" }, { status: 503 });
  }

  let body: { language?: string } = {};
  try {
    body = await req.json();
  } catch {
    // language optional
  }
  const language = typeof body.language === "string" ? body.language.slice(0, 10) : "";

  const languageDirective = language
    ? `\n\nLANGUAGE: Conduct the entire interview in ${language}. Ask questions, follow-ups and the final spoken report in ${language}, regardless of the language the candidate answers in.`
    : "";

  const systemInstruction =
    INTERVIEWER_SYSTEM_PROMPT +
    languageDirective +
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
