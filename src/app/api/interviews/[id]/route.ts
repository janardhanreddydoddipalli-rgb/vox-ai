import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, getInterview, listInterviewQa } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const iv = await getInterview(id, user.id);
  if (!iv) return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  const qa = await listInterviewQa(id);
  return NextResponse.json({
    id: iv.id,
    role: iv.role,
    level: iv.level,
    status: iv.status,
    questionCount: qa.length,
    hasResume: !!iv.resumeId,
    qa: qa.map((q) => ({
      order: q.order,
      question: q.questionText,
      answer: q.answerText,
      score: q.evaluation?.score ?? null,
    })),
  });
}
