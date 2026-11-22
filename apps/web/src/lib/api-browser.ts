// The browser's client for services/api (ADR 0004): a 5-minute JWT from
// GET /api/token, kept in memory only and refreshed shortly before it expires,
// sent as Authorization: Bearer. The API allows this origin by CORS.
import { createVoxApiClient } from "@vox/api-client";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const REFRESH_BEFORE_MS = 30_000;

export class SignedOutError extends Error {
  constructor() {
    super("Please sign in to continue.");
  }
}

let cached: { token: string; expiresAt: number } | null = null;
let pending: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const res = await fetch("/api/token", { cache: "no-store" });
  if (res.status === 401) throw new SignedOutError();
  if (!res.ok) throw new Error(`Vox is unavailable right now (${res.status}).`);
  const { token, expires_in } = (await res.json()) as { token: string; expires_in: number };
  cached = { token, expiresAt: Date.now() + expires_in * 1000 };
  return token;
}

export function apiToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - REFRESH_BEFORE_MS) return Promise.resolve(cached.token);
  pending ??= fetchToken().finally(() => {
    pending = null;
  });
  return pending;
}

/** The current token without waiting (null if none is valid), for page unload. */
export function currentToken(): string | null {
  return cached && Date.now() < cached.expiresAt ? cached.token : null;
}

export const api = createVoxApiClient({ baseUrl: API_URL, getToken: apiToken });

/** Raw call with the same token: multipart uploads, SSE streams, binary downloads. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await apiToken()}`);
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}

/** A problem+json response's detail, or a fallback. */
export async function problemDetail(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string } | null;
  return body?.detail ?? fallback;
}
