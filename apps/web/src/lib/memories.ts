// The signed-in user's memories for the settings page (server side, from services/api).
import { apiFor } from "./api-server";

export type MemoryView = { id: string; kind: string; text: string; createdAt: string };

export async function listMyMemories(userId: string): Promise<MemoryView[]> {
  const res = await apiFor(userId).GET("/v1/memories");
  if (!res.data) throw new Error(`memories API failed: ${res.response.status}`);
  return res.data.memories.map((m) => ({
    id: m.id,
    kind: m.kind,
    text: m.text,
    createdAt: new Date(m.created_at).toISOString(),
  }));
}
