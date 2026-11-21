// Gemini embeddings for long-term memory and document retrieval. Called only
// from the server; the key comes from the environment.
import { GEMINI_EMBEDDING_MODEL } from "./config";

// gemini-embedding-001 returns 3072 dims unless outputDimensionality is set;
// the pgvector columns are vector(768), so it is always requested explicitly.
export const EMBEDDING_DIMENSIONS = 768;

// Documents (stored) and queries (searched with) are embedded differently;
// matching task types measurably improves retrieval.
export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

// Dot product of two equal-length vectors (both unit-normalized by
// embedTexts, so this is the cosine similarity).
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// Truncated (Matryoshka) embeddings are not unit length; re-normalise so
// dot product and pgvector cosine distance agree.
function l2Normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n > 0 ? v.map((x) => x / n) : v;
}

export async function embedTexts(texts: string[], taskType: EmbeddingTaskType = "RETRIEVAL_DOCUMENT"): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  if (texts.length === 0) return [];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${GEMINI_EMBEDDING_MODEL}`,
          content: { parts: [{ text: t }] },
          taskType,
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini embeddings failed: ${res.status}`);
  const data = (await res.json()) as { embeddings?: { values: number[] }[] };
  const embeddings = data.embeddings?.map((e) => e.values);
  if (!embeddings || embeddings.length !== texts.length || embeddings.some((e) => e.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error("Gemini embeddings returned a malformed response");
  }
  return embeddings.map(l2Normalize);
}

// Single-text helper for search queries (memory recall, document search).
export async function embedText(text: string, taskType: EmbeddingTaskType = "RETRIEVAL_QUERY"): Promise<number[]> {
  return (await embedTexts([text], taskType))[0];
}
