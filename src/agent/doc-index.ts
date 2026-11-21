// Document indexing for RAG: chunk the user's resume text and job
// description, embed the chunks, and (re)index them into doc_chunks.
import { embedTexts } from "@/lib/embeddings";
import { createDocChunk, deleteDocChunksForUser } from "@/lib/db/repository";

// ~ 900 characters (~200 tokens) per chunk, split on paragraph then sentence
// boundaries, so chunks keep document structure.
const CHUNK_CHARS = 900;

export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const paragraphs = text.split(/\n\s*\n+/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const pieces = paragraphs.length > 0 ? paragraphs : [clean];
  for (const piece of pieces) {
    if (piece.length > CHUNK_CHARS) {
      // Split long paragraphs on sentence boundaries.
      const sentences = piece.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) ?? [piece];
      for (const s of sentences) {
        if (current.length + s.length > CHUNK_CHARS && current) {
          chunks.push(current.trim());
          current = "";
        }
        current += s + " ";
      }
    } else if (current.length + piece.length > CHUNK_CHARS && current) {
      chunks.push(current.trim());
      current = piece;
    } else {
      current += (current ? " " : "") + piece;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 20);
}

// Idempotent: replaces the user's existing chunks for this source first.
export async function indexDocument(userId: string, source: "resume" | "jd", text: string): Promise<number> {
  const chunks = chunkText(text).slice(0, 50);
  if (chunks.length === 0) return 0;
  const embeddings = await embedTexts(chunks);
  await deleteDocChunksForUser(userId, source);
  for (let i = 0; i < chunks.length; i++) {
    await createDocChunk({ userId, source, text: chunks[i], embedding: embeddings[i] });
  }
  return chunks.length;
}
