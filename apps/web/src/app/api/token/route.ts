// GET /api/token: a 5-minute EdDSA JWT for calling services/api directly
// from the browser (Authorization: Bearer). Auth.js session required
// (middleware + check below). Keep the token in memory; never in storage.
import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { API_TOKEN_TTL_SECONDS, apiTokensConfigured, mintApiToken } from "@/lib/api-token";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  if (!apiTokensConfigured()) {
    return NextResponse.json({ error: "API tokens are not configured" }, { status: 503, headers: NO_STORE });
  }
  const token = await mintApiToken(userId);
  return NextResponse.json({ token, expires_in: API_TOKEN_TTL_SECONDS }, { headers: NO_STORE });
}
