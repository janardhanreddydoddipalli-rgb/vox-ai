import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, deleteAllUserData } from "@/lib/db";
import { routeTarget } from "@/lib/route-flags";
import { deleteMeViaApi } from "@/lib/interviews";

export const runtime = "nodejs";

// Privacy: wipe everything belonging to the signed-in user, in every table
// (see deleteAllUserData and tests/delete-user-data.test.ts).
export async function DELETE() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (routeTarget("INTERVIEWS") === "fastapi") return deleteMeViaApi(user.id);
  const sessionsDeleted = await deleteAllUserData(user.id);
  return NextResponse.json({ ok: true, sessionsDeleted });
}
