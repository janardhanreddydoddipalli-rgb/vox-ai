// Typed client for services/api (not used by apps/web until M3).
// Types come from openapi.json: regenerate with `make api-openapi`.
import createClient, { type Middleware } from "openapi-fetch";
import type { paths, components } from "./schema";

export type { paths, components };
export type Me = components["schemas"]["Me"];

// RFC 9457 problem+json, the shape of every API error.
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  request_id?: string;
  // Set when one status has several meanings, e.g. 429 "budget_exceeded".
  code?: string;
};

export type VoxApiClientOptions = {
  baseUrl: string;
  // Returns a current /api/token JWT (cache it in memory until shortly before expiry).
  getToken: () => Promise<string>;
};

export function createVoxApiClient({ baseUrl, getToken }: VoxApiClientOptions) {
  const client = createClient<paths>({ baseUrl });
  const auth: Middleware = {
    async onRequest({ request }) {
      request.headers.set("Authorization", `Bearer ${await getToken()}`);
      return request;
    },
  };
  client.use(auth);
  return client;
}
