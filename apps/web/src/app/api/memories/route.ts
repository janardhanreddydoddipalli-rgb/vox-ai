import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { upsertUserByEmail } from "@/lib/db";
import { checkRate } from "@/lib/rate-limit";
import { deleteMyMemory, listMyMemories } from "@/lib/memories";
import { routeTarget } from "@/lib/route-flags";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ memories: await listMyMemories(user.id) });
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function DELETE(req: NextRequest) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // services/api applies the same per-user limit itself when it serves the route.
  if (routeTarget("MEMORIES") === "next") {
    const limited = await checkRate(req, "memories-delete", user.id);
    if (limited) return limited;
  }

  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { id: uuid }" }, { status: 400 });
  return deleteMyMemory(user.id, parsed.data.id);
}
