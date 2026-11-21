// Gemini embeddings for long-term memory and document retrieval. Called only
// from the server; the key comes from the environment.
import { GEMINI_EMBEDDING_MODEL } from "./config";

export const EMBEDDING_DIMENSIONS = 768;

// Dot product of two equal-length vectors (both unit-normalized by the
// embedding API, so this is the cosine similarity).
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
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
  return embeddings;
}

export async function embedText(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0];
}
