// Vox's interview tools. Each tool = { name, description, zod input schema,
// handler }, registered into the global registry on import.
import { z } from "zod";
import { GEMINI_MODEL } from "@/lib/config";
import { listQuestions } from "@/lib/db/repository";
import { registerTool, type ToolContext } from "./index";
import { advanceQuestion } from "../state";

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
});

export const getQuestion = {
  name: "get_question",
  description:
    "Get the next interview question for a role and seniority level. Pass the ids of questions already asked in this interview so the same question never repeats.",
  inputSchema: getQuestionInput,
  handler: async (input: unknown) => {
    const { role, level, asked_ids } = getQuestionInput.parse(input);
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
    const picked = source[Math.floor(Math.random() * source.length)];
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
  handler: async (input: unknown) => {
    const { question_id, answer_text } = evaluateInput.parse(input);
    const bank = await listQuestions();
    const question = bank.find((q) => q.id === question_id);
    if (!question) return { error: `Unknown question_id: ${question_id}` };
    return evaluateWithGemini(question.text, answer_text);
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
    await advanceQuestion(ctx.interviewId);
    const { completeInterview } = await import("../state");
    await completeInterview(ctx.interviewId);
    return { status: "complete" };
  },
};

registerTool(getQuestion);
registerTool(evaluateAnswer);
registerTool(endInterview);
