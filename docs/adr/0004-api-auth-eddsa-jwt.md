# ADR 0004: Web → API auth with short-lived EdDSA JWTs

- Status: Accepted (implemented in M2; not yet used by any browser call)
- Date: 2026-11-22

## Context

Users sign in through Auth.js in `apps/web` (Google only, ADR 0002). From M3 the browser calls `services/api` directly for interview data, SSE and voice, so the API must know **which user** is calling, without sharing the Auth.js session cookie or secret, and without the API ever being able to mint identities itself.

## Decision

1. **The web app mints, the API only verifies.**
   - `GET /api/token` (Auth.js session required) returns a JWT signed with **Ed25519 (EdDSA)**.
   - The private key exists only in the web environment (`API_JWT_PRIVATE_KEY`). The API holds only the public key (`JWT_PUBLIC_KEY`), so a leak from the API can't forge tokens.
2. **Claims:**
   - `iss=vox-web`, `aud=vox-api`
   - `sub=<users.id UUID>`
   - a unique `jti`
   - `iat`, and `exp = iat + 300 s`

   The API requires all of them, allows 30 s of clock skew, and accepts **only** `EdDSA`. The algorithm is fixed server-side, so `alg=none` and HS256-with-the-public-key confusion fail (both are tested).
3. **Transport:** `Authorization: Bearer <token>`. The browser keeps it in memory only (never `localStorage`) and fetches a new one shortly before expiry. Responses are `Cache-Control: no-store`. CORS on the API allows only `WEB_ORIGIN`, with no credentials.
4. **Identity bootstrap:** `POST /internal/users/upsert` resolves an email to the stable user id.
   - It's protected by a shared service credential (`X-Internal-Token`, at least 32 characters, compared in constant time).
   - It's excluded from the public OpenAPI schema.
   - The Auth.js `jwt` callback calls it at sign-in behind `AUTH_UPSERT_VIA_API` (default **off** in M2, since the web app still has its own DB access).
5. **Failure shape:** every auth failure is `401 application/problem+json` with `WWW-Authenticate: Bearer`. A token for a deleted user is also 401.
6. **Keys:** one pair per environment, generated with `apps/web/scripts/generate-api-jwt-keys.mjs`.

## Consequences

- **Revocation:** tokens can't be revoked individually. The 5-minute lifetime bounds the exposure, and deleting a user takes effect at once (lookup by `sub`). A `jti` denylist can be added if ever needed.
- **Rotation:** today it means a coordinated swap (new public key on the API, then the private key on the web) with up to 5 minutes of 401s. Support for two public keys (`kid`) can come when we first rotate.
- **Verified end to end (2026-11-22):**
  - A token minted by `apps/web/src/lib/api-token.ts` was accepted by a running API (`/v1/me` → 200); flipping one character gave 401.
  - `upsertUserViaApi` returned a stable id, and a wrong service credential gave 401.
- **Rejected alternatives:**
  - Sharing the Auth.js secret (HS256): the API could mint tokens, and a leak compromises both.
  - Proxying everything through Next.js (BFF): adds a hop to SSE and voice latency.
  - Opaque tokens checked against a session table: a DB lookup per request, plus a shared store.
