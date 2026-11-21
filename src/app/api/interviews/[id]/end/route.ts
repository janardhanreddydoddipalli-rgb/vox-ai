import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, getInterview, listInterviewQa } from "@/lib/db";
import { generateReportForInterview } from "@/agent/report";
import { summarizeInterviewToMemories } from "@/agent/memory";

// End the interview: generate (or reuse) the report and mark it complete.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const iv = await getInterview(id, user.id);
  if (!iv) return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  if (iv.report) return NextResponse.json({ id: iv.id, report: iv.report });

  try {
    const report = await generateReportForInterview(id, user.id);
    // Distill the evaluations into long-term memories. Report generation must
    // still succeed if the summarizer fails, so this is best-effort.
    try {
      const qa = await listInterviewQa(id);
      await summarizeInterviewToMemories(
        user.id,
        qa.map((q) => ({ question: q.questionText, answer: q.answerText, evaluation: q.evaluation })),
      );
    } catch (memErr) {
      console.error("memory summarization failed", memErr);
    }
    return NextResponse.json({ id, report });
  } catch (err) {
    console.error("report generation failed", err);
    return NextResponse.json({ error: "Could not generate the report. Please try again." }, { status: 502 });
  }
}
