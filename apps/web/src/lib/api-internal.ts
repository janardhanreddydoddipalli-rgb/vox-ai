// Server-to-server calls from apps/web to services/api /internal/* (never
// from the browser). Authenticated with the shared INTERNAL_API_TOKEN.

export type UpsertedUser = { user_id: string };

export function upsertViaApiEnabled(): boolean {
  return process.env.AUTH_UPSERT_VIA_API === "1";
}

// Resolves a signed-in identity to its stable users.id through the API.
export async function upsertUserViaApi(identity: {
  email: string;
  name?: string | null;
  image?: string | null;
}): Promise<string> {
  const base = process.env.API_INTERNAL_URL?.replace(/\/$/, "");
  const token = process.env.INTERNAL_API_TOKEN;
  if (!base || !token) throw new Error("API_INTERNAL_URL / INTERNAL_API_TOKEN are not set");
  const res = await fetch(`${base}/internal/users/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Token": token },
    body: JSON.stringify({ email: identity.email, name: identity.name ?? null, image: identity.image ?? null }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`internal user upsert failed: ${res.status}`);
  const data = (await res.json()) as UpsertedUser;
  return data.user_id;
}
