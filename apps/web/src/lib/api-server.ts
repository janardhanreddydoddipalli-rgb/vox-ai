// Server components reading from services/api on behalf of the signed-in user:
// a fresh 5-minute token (ADR 0004) and the generated typed client.
import { createVoxApiClient } from "@vox/api-client";
import { mintApiToken } from "./api-token";

export function apiFor(userId: string) {
  const baseUrl = process.env.API_INTERNAL_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new Error("API_INTERNAL_URL is not set");
  return createVoxApiClient({ baseUrl, getToken: () => mintApiToken(userId) });
}
