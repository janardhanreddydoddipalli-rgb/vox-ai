// GET /api/token: a 5-minute EdDSA JWT for calling services/api directly
// from the browser (Authorization: Bearer). Auth.js session required
// (middleware + check below). Keep the token in memory; never in storage.
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { upsertUserByEmail } from "@/lib/db";
import { checkRate } from "@/lib/rate-limit";
import { API_TOKEN_TTL_SECONDS, apiTokensConfigured, mintApiToken } from "@/lib/api-token";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  if (!apiTokensConfigured()) {
    return NextResponse.json({ error: "API tokens are not configured" }, { status: 503, headers: NO_STORE });
  }

  // Pass name/image through so this lookup never blanks the stored profile.
  const user = await upsertUserByEmail(email, session.user?.name ?? null, session.user?.image ?? null);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });

  const limited = await checkRate(req, "api-token", user.id, 60);
  if (limited) return limited;

  const token = await mintApiToken(user.id);
  return NextResponse.json({ token, expires_in: API_TOKEN_TTL_SECONDS }, { headers: NO_STORE });
}
