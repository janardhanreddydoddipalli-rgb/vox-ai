// Server-side calls from apps/web to services/api on behalf of the signed-in
// user: a fresh 5-minute token (ADR 0004) and the generated typed client.
import { createVoxApiClient } from "@vox/api-client";
import { mintApiToken } from "./api-token";

export function apiFor(userId: string) {
  const baseUrl = process.env.API_INTERNAL_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new Error("API_INTERNAL_URL is not set");
  return createVoxApiClient({ baseUrl, getToken: () => mintApiToken(userId) });
}

// Raw call (multipart uploads, binary downloads) with the same per-user token.
export async function apiFetch(userId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const baseUrl = process.env.API_INTERNAL_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new Error("API_INTERNAL_URL is not set");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await mintApiToken(userId)}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers, cache: "no-store" });
}

// Maps an API error status to the web route's existing JSON error contract.
export function apiErrorResponse(status: number, notFound = "Not found", retryAfter?: string | null) {
  if (status === 404) return Response.json({ error: notFound }, { status: 404 });
  if (status === 429) {
    return Response.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : undefined },
    );
  }
  if (status === 401) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ error: "Upstream error" }, { status: 502 });
}
