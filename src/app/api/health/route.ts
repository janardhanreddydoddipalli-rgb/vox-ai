import { NextResponse } from "next/server";
import { GEMINI_MODEL } from "@/lib/config";

export const runtime = "nodejs";

// Health/readiness: reports which brain is live so the client can label the
// session, plus database reachability.
export async function GET() {
  let db: "ok" | "error" = "ok";
  try {
    const { getTurns } = await import("@/lib/db");
    getTurns("health-check");
  } catch {
    db = "error";
  }
  return NextResponse.json({
    ok: db === "ok",
    engine: process.env.GEMINI_API_KEY ? "gemini" : "browser",
    model: GEMINI_MODEL,
    db,
  });
}
