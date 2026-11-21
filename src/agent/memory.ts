// Post-interview memory summarizer: after end_interview, distill the
// evaluations into 3-6 durable memories (strengths, weaknesses, preferences)
// and store them with embeddings, deduplicating against the user's existing
// memories and within the new batch (cosine >= DEDUPE_THRESHOLD = duplicate).
import { GEMINI_MODEL } from "@/lib/config";
import { embedTexts, cosineSimilarity } from "@/lib/embeddings";
import { createMemory, findSimilarMemories, type MemoryKind } from "@/lib/db/repository";

export const DEDUPE_THRESHOLD = 0.9;
const MIN_MEMORIES = 3;
const MAX_MEMORIES = 6;
const KINDS: MemoryKind[] = ["strength", "weakness", "preference"];

const responseSchema = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: KINDS },
          text: { type: "string" },
        },
        required: ["kind", "text"],
      },
    },
  },
  required: ["memories"],
};

export type QaForMemory = { question: string; answer: string; evaluation: unknown };
export type SummarizerResult = { created: { id: string; kind: MemoryKind; text: string }[]; skipped: number };

async function proposeMemories(qa: QaForMemory[]): Promise<{ kind: MemoryKind; text: string }[]> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const transcript = qa
    .map((q, i) => `Q${i + 1}: ${q.question}\nA: ${q.answer}\nEvaluation: ${JSON.stringify(q.evaluation ?? {})}`)
    .join("\n\n");

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
                `From this interview's evaluations, write ${MIN_MEMORIES}-${MAX_MEMORIES} durable memories about the candidate ` +
                "that would help a future interviewer. Each memory is one short sentence (max 25 words) naming the " +
                "specific topic. kind = 'weakness' for a knowledge or skill gap, 'strength' for a clearly strong area, " +
                "'preference' for how the candidate likes to answer or work. Base every memory on the evaluations only.\n\n" +
                transcript,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.3, responseMimeType: "application/json", responseSchema },
    }),
  });
  if (!res.ok) throw new Error(`Gemini memory summarizer failed: ${res.status}`);
  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  const parsed = JSON.parse(text) as { memories?: { kind?: string; text?: string }[] };
  return (parsed.memories ?? [])
    .filter((m): m is { kind: MemoryKind; text: string } => KINDS.includes(m.kind as MemoryKind) && !!m.text?.trim())
    .map((m) => ({ kind: m.kind, text: m.text.trim() }))
    .slice(0, MAX_MEMORIES);
}

export async function summarizeInterviewToMemories(userId: string, qa: QaForMemory[]): Promise<SummarizerResult> {
  if (qa.length === 0) return { created: [], skipped: 0 };
  const candidates = await proposeMemories(qa);
  if (candidates.length === 0) return { created: [], skipped: 0 };

  const embeddings = await embedTexts(candidates.map((c) => c.text));
  const created: SummarizerResult["created"] = [];
  const keptVectors: number[][] = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const vec = embeddings[i];
    const [nearest] = await findSimilarMemories(userId, vec, 1);
    const dupOfExisting = nearest !== undefined && nearest.similarity >= DEDUPE_THRESHOLD;
    const dupInBatch = keptVectors.some((v) => cosineSimilarity(v, vec) >= DEDUPE_THRESHOLD);
    if (dupOfExisting || dupInBatch) {
      skipped++;
      continue;
    }
    const row = await createMemory({ userId, kind: cand.kind, text: cand.text, embedding: vec });
    created.push({ id: row.id, kind: cand.kind, text: cand.text });
    keptVectors.push(vec);
  }
  console.info("[memory] summarized interview", { userId, created: created.length, skipped });
  return { created, skipped };
}
