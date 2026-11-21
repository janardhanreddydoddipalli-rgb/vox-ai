// Memories for the signed-in user, from apps/web's DB or services/api
// depending on ROUTE_MEMORIES (M3). The web response shape stays the same.
import { listMemories, getMemory, deleteMemory } from "@/lib/db";
import { apiFor, apiErrorResponse } from "./api-server";
import { routeTarget } from "./route-flags";

export type MemoryView = { id: string; kind: string; text: string; createdAt: string };

const NOT_FOUND = "Memory not found";

export async function listMyMemories(userId: string): Promise<MemoryView[]> {
  if (routeTarget("MEMORIES") === "fastapi") {
    const res = await apiFor(userId).GET("/v1/memories");
    if (!res.data) throw new Error(`memories API failed: ${res.response.status}`);
    return res.data.memories.map((m) => ({
      id: m.id,
      kind: m.kind,
      text: m.text,
      createdAt: new Date(m.created_at).toISOString(),
    }));
  }
  return (await listMemories(userId)).map((m) => ({
    id: m.id,
    kind: m.kind,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
  }));
}

// Returns the route's response: { ok: true }, or the error contract (404/429/…).
export async function deleteMyMemory(userId: string, id: string): Promise<Response> {
  if (routeTarget("MEMORIES") === "fastapi") {
    const { response } = await apiFor(userId).DELETE("/v1/memories/{memory_id}", {
      params: { path: { memory_id: id } },
    });
    if (response.status === 204) return Response.json({ ok: true });
    return apiErrorResponse(response.status, NOT_FOUND, response.headers.get("retry-after"));
  }
  // Ownership is enforced inside getMemory/deleteMemory: another user's id
  // resolves to null and returns 404.
  if (!(await getMemory(id, userId))) return Response.json({ error: NOT_FOUND }, { status: 404 });
  await deleteMemory(id, userId);
  return Response.json({ ok: true });
}
