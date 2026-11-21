// Vox's interview tools. Each tool = { name, description, zod input schema,
// handler }, registered into the global registry on import.
import { z } from "zod";
import { GEMINI_MODEL } from "@/lib/config";
import { listQuestions, getResume, getInterview, appendInterviewQa } from "@/lib/db/repository";
import { registerTool, type ToolContext } from "./index";
import { advanceQuestion, completeInterview } from "../state";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

// --- get_question ----------------------------------------------------------
const getQuestionInput = z.object({
  role: z.string().min(1).max(80),
  level: z.enum(["junior", "mid", "senior"]),
  asked_ids: z.array(z.string().uuid()).max(100).default([]),
  use_resume: z.boolean().default(false),
  focus_topics: z.array(z.string().min(1).max(120)).max(10).default([]),
});

// Build a resume-based question ("Tell me about <project>") from the
// interview's stored resume. Deterministic per question index; null when
// there is no resume or the projects were already covered.
async function resumeQuestion(ctx: ToolContext, askedIds: string[]) {
  const iv = await ownedInterview(ctx);
  if (!iv?.resumeId) return null;
  const resume = await getResume(iv.resumeId, iv.userId);
  if (!resume || resume.projects.length === 0) return null;
  const askedCount = askedIds.length;
  const project = resume.projects[askedCount % resume.projects.length];
  return {
    question_id: `resume:${resume.id}:${askedCount}`,
    category: "resume",
    question: `Tell me about your work on ${project.name}. ${project.summary}`.trim(),
    source: "resume",
  };
}

export const getQuestion = {
  name: "get_question",
  description:
    "Get the next interview question for a role and seniority level. Pass the ids of questions already asked in this interview so the same question never repeats. Set use_resume to true to ask about the candidate's résumé (projects, experience).",
  inputSchema: getQuestionInput,
  handler: async (input: unknown, ctx: ToolContext) => {
    const { role, level, asked_ids, use_resume, focus_topics } = getQuestionInput.parse(input);

    // Resume-based question when asked and a resume exists.
    if (use_resume && ctx.interviewId) {
      const rq = await resumeQuestion(ctx, asked_ids);
      if (rq) return { ...rq, level };
    }

    const bank = await listQuestions();
    // Category match by role keywords; fall back to the whole bank.
    const r = role.toLowerCase();
    const categories = new Set<string>();
    if (/front|react|ui|web|css/.test(r)) categories.add("frontend");
    if (/back|api|server|node|python|java|database/.test(r)) categories.add("backend");
    if (/dsa|algorithm|data structure|coding/.test(r)) categories.add("dsa");
    if (/hr|behavior|general/.test(r)) categories.add("hr");
    const pool = bank.filter((q) => (categories.size ? categories.has(q.category) : true));
    const fresh = pool.filter((q) => !asked_ids.includes(q.id));
    const source = fresh.length > 0 ? fresh : pool; // if everything was asked, reuse
    if (source.length === 0) return { question: null, message: "The question bank is empty." };
    // Prioritise the candidate's known weaknesses: questions whose text or
    // category matches a focus topic are picked with weight.
    let picked: (typeof source)[number];
    if (focus_topics.length > 0) {
      const focus = focus_topics.map((t) => t.toLowerCase());
      const matches = source.filter((q) => {
        const hay = `${q.category} ${q.text}`.toLowerCase();
        return focus.some((t) => hay.includes(t) || t.split(/\s+/).some((w) => w.length > 3 && hay.includes(w)));
      });
      // 70% of the time drill the weakness when a matching question exists.
      const preferWeakness = matches.length > 0 && Math.random() < 0.7;
      const pool = preferWeakness ? matches : source;
      picked = pool[Math.floor(Math.random() * pool.length)];
    } else {
      picked = source[Math.floor(Math.random() * source.length)];
    }
    return { question_id: picked.id, category: picked.category, question: picked.text, level };
  },
};

// --- evaluate_answer --------------------------------------------------------
const evaluateInput = z.object({
  question_id: z.string().uuid(),
  answer_text: z.string().min(1).max(4000),
});

export const evaluationSchema = z.object({
  score: z.number().int().min(1).max(10),
  clarity: z.string(),
  depth: z.string(),
  correctness: z.string(),
  missing_points: z.array(z.string()),
  follow_up_needed: z.boolean(),
  follow_up_question: z.string().optional(),
});

export type Evaluation = z.infer<typeof evaluationSchema>;

// Structured Gemini call with a JSON response schema, validated against
// evaluationSchema before returning — a malformed model answer never leaves
// this function.
export async function evaluateWithGemini(questionText: string, answerText: string): Promise<Evaluation> {
  const res = await fetch(`${BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `Interview question: ${questionText}\n\nCandidate answer: ${answerText}\n\n` +
                "Evaluate this answer as a rigorous but fair interviewer. Grade the answer 1-10, " +
                "and assess clarity, depth and correctness in one spoken-style sentence each. " +
                "List the concrete points the answer missed. Decide if a follow-up question is needed.",
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            score: { type: "integer" },
            clarity: { type: "string" },
            depth: { type: "string" },
            correctness: { type: "string" },
            missing_points: { type: "array", items: { type: "string" } },
            follow_up_needed: { type: "boolean" },
            follow_up_question: { type: "string", nullable: true },
          },
          required: ["score", "clarity", "depth", "correctness", "missing_points", "follow_up_needed"],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini evaluation failed: ${res.status}`);
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini evaluation returned malformed JSON");
  }
  return evaluationSchema.parse(parsed);
}

export const evaluateAnswer = {
  name: "evaluate_answer",
  description:
    "Evaluate the candidate's answer to the current question. Returns a structured score out of 10, clarity/depth/correctness notes, missing points, and whether a follow-up question is needed. Use its follow_up_question when follow_up_needed is true.",
  inputSchema: evaluateInput,
  handler: async (input: unknown, ctx: ToolContext) => {
    const { question_id, answer_text } = evaluateInput.parse(input);
    // Refuse before the paid model call when the interview isn't the caller's.
    const iv = ctx.interviewId ? await ownedInterview(ctx) : null;
    if (ctx.interviewId && !iv) return { error: "Interview not found" };
    let questionText = "";
    if (question_id.startsWith("resume:")) {
      // Resume question: recover its text from the stored resume projects.
      const resume = iv?.resumeId ? await getResume(iv.resumeId, iv.userId) : null;
      const project = resume?.projects.find((p) => question_id.includes(p.name));
      questionText = project ? `Tell me about your work on ${project.name}. ${project.summary}` : "Résumé project question";
    } else {
      const bank = await listQuestions();
      const question = bank.find((q) => q.id === question_id);
      if (!question) return { error: `Unknown question_id: ${question_id}` };
      questionText = question.text;
    }
    const evaluation = await evaluateWithGemini(questionText, answer_text);
    await recordQa(ctx, question_id, questionText, answer_text, evaluation);
    return evaluation;
  },
};

// --- end_interview ----------------------------------------------------------
const endInput = z.object({});

export const endInterview = {
  name: "end_interview",
  description:
    "End the interview. Call this when the candidate asks to stop, the planned questions are exhausted, or you have delivered a closing summary.",
  inputSchema: endInput,
  handler: async (_input: unknown, ctx: ToolContext) => {
    if (!ctx.interviewId) return { error: "No active interview" };
    const iv = await ownedInterview(ctx);
    if (!iv) return { error: "Interview not found" };
    await advanceQuestion(iv.id, iv.userId);
    await completeInterview(iv.id, iv.userId);
    return { status: "complete" };
  },
};

// The context's interview, only if it belongs to the context's user. Every
// tool goes through this — never load an interview by id alone.
async function ownedInterview(ctx: ToolContext) {
  if (!ctx.interviewId || !ctx.userId) return null;
  return getInterview(ctx.interviewId, ctx.userId);
}

// Read the interview's resume, if any, as structured JSON.
export const readResume = {
  name: "read_resume",
  description:
    "Read the candidate's résumé as structured JSON: skills, projects (name + summary), experience (company, role, period). Call before asking résumé-based questions.",
  inputSchema: z.object({}),
  handler: async (_input: unknown, ctx: ToolContext) => {
    if (!ctx.interviewId) return { error: "No active interview" };
    const iv = await ownedInterview(ctx);
    if (!iv) return { error: "Interview not found" };
    if (!iv.resumeId) return { error: "No resume was provided for this interview" };
    const resume = await getResume(iv.resumeId, iv.userId);
    if (!resume) return { error: "Resume not found" };
    return {
      skills: resume.skills,
      projects: resume.projects,
      experience: resume.experience,
    };
  },
};

// Persist one answered question (question, answer, evaluation) for the
// interview report. Called by evaluate_answer's handler.
async function recordQa(ctx: ToolContext, questionId: string, questionText: string, answerText: string, evaluation: unknown) {
  if (!ctx.interviewId) return;
  if (!(await ownedInterview(ctx))) return;
  try {
    await appendInterviewQa({
      interviewId: ctx.interviewId,
      questionId: questionId.startsWith("resume:") ? null : questionId,
      questionText,
      answerText,
      evaluation: evaluation as never,
    });
  } catch (err) {
    console.error("failed to record interview QA", err);
  }
}

export { recordQa };

registerTool(getQuestion);
registerTool(evaluateAnswer);
registerTool(endInterview);
registerTool(readResume);
