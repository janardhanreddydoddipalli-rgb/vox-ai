// Report generation: aggregate every QA's evaluation into an overall report
// with per-question better sample answers. Exposed both as an agent tool
// (generate_report) and as the direct generator used by POST .../end.
import { z } from "zod";
import { GEMINI_MODEL } from "@/lib/config";
import { listInterviewQa, getInterview, saveInterviewReport } from "@/lib/db/repository";
import { registerTool, type ToolContext } from "./tools";

export const reportSchema = z.object({
  overall: z.number().min(0).max(10),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  summary: z.string(),
  perQuestion: z
    .array(
      z.object({
        question: z.string(),
        score: z.number().min(0).max(10),
        better_answer: z.string(),
      }),
    )
    .default([]),
});

export type Report = z.infer<typeof reportSchema>;

function geminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key || null;
}

export async function generateReportForInterview(interviewId: string, userId: string): Promise<Report | null> {
  const iv = await getInterview(interviewId, userId);
  if (!iv) return null;
  const qa = await listInterviewQa(interviewId);
  const transcript = qa
    .map((q) => `Q${q.order + 1}: ${q.questionText}\nA: ${q.answerText}\nEvaluation: ${JSON.stringify(q.evaluation ?? {})}`)
    .join("\n\n");
  if (!transcript) {
    // Nothing to grade — an empty complete report.
    const empty: Report = { overall: 0, strengths: [], gaps: ["No answers were recorded."], summary: "The interview ended before any answers were given.", perQuestion: [] };
    await saveInterviewReport(interviewId, empty);
    return empty;
  }

  const key = geminiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Write an interview report from this transcript. For EVERY question include a better_answer: " +
                "a model spoken-style answer (3-6 short sentences) that would have scored 10. " +
                "overall = average of the per-answer scores rounded to one decimal.\n\n" + transcript,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            overall: { type: "number" },
            strengths: { type: "array", items: { type: "string" } },
            gaps: { type: "array", items: { type: "string" } },
            summary: { type: "string" },
            perQuestion: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  score: { type: "number" },
                  better_answer: { type: "string" },
                },
                required: ["question", "score", "better_answer"],
              },
            },
          },
          required: ["overall", "strengths", "gaps", "summary", "perQuestion"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini report failed: ${res.status}`);
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  const report = reportSchema.parse(JSON.parse(text));
  await saveInterviewReport(interviewId, report);
  return report;
}

// Agent tool wrapper.
export const generateReportTool = {
  name: "generate_report",
  description: "Generate the final interview report: overall score, strengths, gaps and a better sample answer per question. Call once when the interview ends.",
  inputSchema: z.object({}),
  handler: async (_input: unknown, ctx: ToolContext) => {
    if (!ctx.interviewId || !ctx.userId) return { error: "No active interview" };
    const report = await generateReportForInterview(ctx.interviewId, ctx.userId);
    if (!report) return { error: "Interview not found" };
    return report;
  },
};

registerTool(generateReportTool);
