// Memory + document retrieval tools. Each tool = { name, description, zod
// input schema, handler }, registered into the global registry on import.
import { z } from "zod";
import { embedText } from "@/lib/embeddings";
import { findSimilarMemories, searchDocChunks, type MemoryKind } from "@/lib/db/repository";
import { registerTool, type ToolContext } from "./index";

const KINDS: MemoryKind[] = ["strength", "weakness", "preference"];

export const recallMemories = {
  name: "recall_memories",
  description:
    "Recall what Vox remembers about this candidate from past interviews: strengths, weaknesses and preferences. Use it to personalise questions or feedback. Returns the top 5 most relevant memories for the query.",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    kind: z.enum(["strength", "weakness", "preference", "any"]).default("any"),
  }),
  handler: async (input: unknown, ctx: ToolContext) => {
    const { query, kind } = recallMemories.inputSchema.parse(input);
    if (!ctx.userId) return { error: "Sign in required" };
    const embedding = await embedText(query);
    const memories = await findSimilarMemories(ctx.userId, embedding, 5, kind === "any" ? undefined : [kind]);
    return { memories };
  },
};

export const searchDocuments = {
  name: "search_documents",
  description:
    "Search the candidate's own uploaded documents (résumé and job description) for relevant passages. Use it to ground questions in the candidate's actual projects or the role's requirements. Returns the top 5 chunks.",
  inputSchema: z.object({ query: z.string().min(1).max(500) }),
  handler: async (input: unknown, ctx: ToolContext) => {
    const { query } = searchDocuments.inputSchema.parse(input);
    if (!ctx.userId) return { error: "Sign in required" };
    const embedding = await embedText(query);
    const chunks = await searchDocChunks(ctx.userId, embedding, 5);
    return { chunks };
  },
};

registerTool(recallMemories);
registerTool(searchDocuments);
