import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, deleteAllUserData } from "@/lib/db";

export const runtime = "nodejs";

// Privacy: wipe everything belonging to the signed-in user — turns, sessions
// and the users row. Sessions cascade via FK; turns are removed explicitly.
export async function DELETE() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sessionsDeleted = await deleteAllUserData(user.id);
  return NextResponse.json({ ok: true, sessionsDeleted });
}
