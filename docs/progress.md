# Migration progress (M3–M4)

One PR per route. Each PR: API tests first, the FastAPI route, a `ROUTE_<NAME>=next|fastapi` flag in apps/web (default `next`), cross-user 404 tests, and E2E green in both flag modes (locally and in CI).

| # | Route | PR | Flag | API tests | Web tests | E2E (next / fastapi) | Status |
|---|---|---|---|---|---|---|---|
| 1 | memories (`GET /v1/memories`, `DELETE /v1/memories/{id}`) | #13 | `ROUTE_MEMORIES` | 64 | 119 | 5 / 5 | merged |
| 2 | turns (`GET /v1/turns`, `GET`/`POST /v1/sessions/{id}/turns`) | #14 | `ROUTE_TURNS` | 81 | 126 | 6 / 6 | merged. Also fixed: a user could write into another user's session and read it back |
| 3 | interviews: create (résumé + JD indexing), list, scores, detail, end (report + memories), PDF, steps; sessions; `DELETE /v1/me`; dashboard/report/debug pages | (open) | `ROUTE_INTERVIEWS` | 116 | 133 | 7 / 7 | in review. Adds the Gemini provider and the cost guard, now metering résumé, report, memory and embedding calls (the web didn't). Document indexing moved here from route 7 (creation needs it). Fixed the debug page's user-id bug |
| 4 | chat SSE | | `ROUTE_CHAT` | | | | |
| 5 | agent loop + tools | | `ROUTE_AGENT` | | | | |
| 6 | voice session + tool bridge (`voice_sessions`) | | `ROUTE_VOICE` | | | | |
| 7 | RAG ingestion | | `ROUTE_RAG` | | | | |
| M4 | remove server code from web; flags default `fastapi` | | | | | | |

## Shared machinery (added with route 1)

- `apps/web/src/lib/route-flags.ts` (`routeTarget`) and `api-server.ts` (`apiFor(userId)`: the typed client plus a fresh token).
- Every database is migrated by Alembic (`scripts/alembic-upgrade.mjs`): `db:migrate`, the web test setup, the evals.
- CI starts the real API with an ephemeral key pair and runs E2E twice (flags `next`, then moved routes `fastapi`).
- API rate limiting (`core/rate_limit.py`): Upstash in production, in-memory otherwise; same buckets as the web app.
