import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { upsertUserByEmail, saveResume, createInterview } from "@/lib/db";
import { db } from "@/lib/db/client";
import { interviews } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { extractPdfText, parseResumeStructure } from "@/lib/resume";
import { indexDocument } from "@/agent/doc-index";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";

export const runtime = "nodejs";

const formSchema = z.object({
  role: z.string().trim().min(1, "Role is required").max(80),
  level: z.enum(["junior", "mid", "senior"]),
  language: z.enum(["en", "hi", "ta", "te"]).default("en"),
  jobDescription: z.string().trim().max(8000).optional().default(""),
});

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const user = await upsertUserByEmail(email);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await checkRate(req, "interviews", user.id);
  if (limit) return limit;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const file = form.get("resume");
  const parsedForm = formSchema.safeParse({
    role: form.get("role"),
    level: form.get("level"),
    language: form.get("language") ?? "en",
    jobDescription: form.get("jobDescription") ?? "",
  });
  if (!parsedForm.success) {
    return NextResponse.json({ error: parsedForm.error.issues[0]?.message ?? "Invalid form" }, { status: 400 });
  }
  if (file && !(file instanceof File) === false && file instanceof File && file.size > 5_000_000) {
    return NextResponse.json({ error: "Resume PDF must be 5 MB or smaller" }, { status: 400 });
  }

  let resumeId: string | undefined;
  if (file instanceof File && file.size > 0) {
    if (file.type && file.type !== "application/pdf") {
      return NextResponse.json({ error: "Resume must be a PDF" }, { status: 400 });
    }
    try {
      const rawText = await extractPdfText(new Uint8Array(await file.arrayBuffer()));
      if (!rawText) return NextResponse.json({ error: "Could not read text from that PDF" }, { status: 400 });
      const structure = await parseResumeStructure(rawText);
      const saved = await saveResume({ userId: user.id, filename: file.name, rawText, ...structure });
      resumeId = saved.id;
      // Index the resume into doc_chunks for RAG (best-effort: the interview
      // can proceed without embeddings).
      try {
        await indexDocument(user.id, "resume", rawText);
      } catch (idxErr) {
        console.error("resume doc indexing failed", idxErr);
      }
    } catch (err) {
      console.error("resume parse failed", err);
      return NextResponse.json({ error: "Could not parse that PDF. Try another file or skip the resume." }, { status: 400 });
    }
  }

  const created = await createInterview(user.id, parsedForm.data.role, parsedForm.data.level);
  await db
    .update(interviews)
    .set({
      resumeId: resumeId ?? null,
      jobDescription: parsedForm.data.jobDescription || null,
      language: parsedForm.data.language,
    })
    .where(eq(interviews.id, created.id));
  // Index the job description into doc_chunks as well (best-effort).
  if (parsedForm.data.jobDescription) {
    try {
      await indexDocument(user.id, "jd", parsedForm.data.jobDescription);
    } catch (idxErr) {
      console.error("jd doc indexing failed", idxErr);
    }
  }
  return NextResponse.json({ id: created.id }, { status: 201 });
}
