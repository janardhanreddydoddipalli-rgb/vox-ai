# Migration progress (M3–M4)

M3: one PR per route. Each PR: API tests first, the FastAPI route, a `ROUTE_<NAME>=next|fastapi` flag in apps/web (default `next`), cross-user 404 tests, and E2E green in both flag modes (locally and in CI). M4: flags defaulted to the API, then the web's own implementations and the flags were removed.

| # | Route | PR | Flag | API tests | Web tests | E2E (next / fastapi) | Status |
|---|---|---|---|---|---|---|---|
| 1 | memories (`GET /v1/memories`, `DELETE /v1/memories/{id}`) | #13 | `ROUTE_MEMORIES` | 64 | 119 | 5 / 5 | merged |
| 2 | turns (`GET /v1/turns`, `GET`/`POST /v1/sessions/{id}/turns`) | #14 | `ROUTE_TURNS` | 81 | 126 | 6 / 6 | merged. Also fixed: a user could write into another user's session and read it back |
| 3 | interviews: create (résumé + JD indexing), list, scores, detail, end (report + memories), PDF, steps; sessions; `DELETE /v1/me`; dashboard/report/debug pages | #15 | `ROUTE_INTERVIEWS` | 116 | 133 | 7 / 7 | merged. Adds the Gemini provider and the cost guard, now metering résumé, report, memory and embedding calls (the web didn't). Document indexing moved here from route 7 (creation needs it). Fixed the debug page's user-id bug |
| 4 | plain chat SSE (`POST /v1/chat`) | #16 | `ROUTE_CHAT` | 130 | 138 | 8 / 8 | merged. Chat is now metered. Fixed: a client disconnect left the model stream open until GC; the dashboard crashed with all flags on `next` and no API configured (CI's `next` run now has no API) |
| 5 | agent loop + 6 tools (`POST /v1/interviews/{id}/turns`) | #17 | `ROUTE_AGENT` | 147 | 143 | 9 / 9 | merged. Explicit tool registry; each tool in a savepoint; evaluation calls metered. Fixed: résumé answers couldn't be evaluated (UUID-only ids) and lost their question text; live voice sessions declared no tools (web) |
| 6 | voice session + tool bridge (`POST /v1/voice/sessions`, `.../{id}/tool-calls`, `.../{id}/usage`) | #18, #19 | `ROUTE_VOICE` | 167 | 154 | 10 / 10 | merged. #18: the Live setup frame sent bare declarations as `setup.tools` (Gemini expects `[{functionDeclarations}]`). #19: Alembic `0002` adds `voice_sessions` and `voice_tool_calls` (expand-only). Tool calls and usage are keyed by a server-issued session id that fixes the user and interview; a retried `call_id` replays the stored result. Tool and usage tokens are metered and usage is kept per session. Without a Gemini key no session can start, so E2E covers the error paths; the happy path is covered by API and web tests. Locked tokens (Q2) and a duration floor (Q1) need a paid live session |
| 7 | RAG: per-row embedding model, hybrid retrieval | #20 | none | 172 | 154 | 10 / 10 | merged. No web route is left to flag: indexing moved with route 3 (interview creation), retrieval with routes 5 and 6 (agent and voice tools). Alembic `0003` (expand-only): `embedding_model` and `embedding_dim` on `user_memories` and `doc_chunks`, with defaults matching what the web writes, and a generated `tsvector` with a GIN index on `doc_chunks`. `search_documents` fuses vector and full-text ranks with RRF (k=60). Recall, dedupe and the vector side only compare vectors from the same model. The unused `RAG` flag name was dropped |
| M4.1 | flags default to `fastapi`; `ROUTE_<NAME>=next` is the rollback | #21 | all | 172 | 154 | 10 / 10 (default / rollback) | merged. CI ran E2E on the default and on the full rollback (no API configured) |
| M4.2a | evals and question-bank seeding move to services/api (Python); `evals.yml` starts the API for the real-model E2E | #22 | | 179 | 153 | 10 / 10 | merged. Not run against the real model here (paid); a fake-provider dry run of one eval case is in CI. `evaluate_answer`'s grading is reusable as `grade()` |
| M4.2 | browser calls services/api directly (token from `/api/token`); web API routes, flags, Drizzle, the agent and every other server module removed | #23 | removed | 179 | 45 | 10 | The web keeps Auth.js, `/api/token`, the upsert (always on; `session.user.id` = `users.id`) and server pages reading the API. The PDF downloads through the token. Fixed: live-mode playground history was never saved (sent `live` as the engine). Web tests are unit tests only; E2E calls the API directly and the UI exercises CORS |

## Shared machinery

During M3 (removed in M4 with the web's own implementations): `routeTarget()` flags and per-route proxies in apps/web, and CI running E2E in both flag modes.

Still in place:
- `apps/web/src/lib/api-browser.ts` (browser: token cache + typed client) and `api-server.ts` (server pages: `apiFor(userId)` with a freshly minted token).
- Every database is migrated by Alembic: `pnpm db:migrate`, the API tests, the evals.
- CI starts the real API with an ephemeral key pair and runs E2E against it.
- API rate limiting (`core/rate_limit.py`): Upstash in production, in-memory otherwise.
