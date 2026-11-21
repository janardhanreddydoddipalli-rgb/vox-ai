import { NextResponse } from "next/server";
import { GEMINI_MODEL } from "@/lib/config";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";

// Health/readiness: reports which brain is live plus database reachability.
export async function GET() {
  let dbStatus: "ok" | "error" = "ok";
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbStatus = "error";
  }
  return NextResponse.json({
    ok: dbStatus === "ok",
    engine: process.env.GEMINI_API_KEY ? "gemini" : "browser",
    model: GEMINI_MODEL,
    db: dbStatus,
  });
}
