import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, listMemories, getMemory, deleteMemory } from "@/lib/db";
import { checkRate } from "@/lib/rate-limit";

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const memories = await listMemories(user.id);
  return NextResponse.json({
    memories: memories.map((m) => ({ id: m.id, kind: m.kind, text: m.text, createdAt: m.createdAt.toISOString() })),
  });
}

const deleteSchema = z.object({ id: z.string().uuid() });

export async function DELETE(req: NextRequest) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRate(req, "memories-delete", user.id);
  if (limited) return limited;

  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { id: uuid }" }, { status: 400 });

  // Ownership is enforced inside getMemory/deleteMemory: another user's id
  // resolves to null and returns 404.
  const existing = await getMemory(parsed.data.id, user.id);
  if (!existing) return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  await deleteMemory(parsed.data.id, user.id);
  return NextResponse.json({ ok: true });
}
