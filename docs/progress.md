# Migration progress (M3–M4)

One PR per route. Each PR: API tests first, the FastAPI route, a `ROUTE_<NAME>=next|fastapi` flag in apps/web (default `next`), cross-user 404 tests, and E2E green in both flag modes (locally and in CI).

| # | Route | PR | Flag | API tests | Web tests | E2E (next / fastapi) | Status |
|---|---|---|---|---|---|---|---|
| 1 | memories (`GET /v1/memories`, `DELETE /v1/memories/{id}`) | #13 | `ROUTE_MEMORIES` | 64 | 119 | 5 / 5 | merged |
| 2 | turns (`GET /v1/turns`, `GET`/`POST /v1/sessions/{id}/turns`) | #14 | `ROUTE_TURNS` | 81 | 126 | 6 / 6 | merged. Also fixed: a user could write into another user's session and read it back |
| 3 | interviews: create (résumé + JD indexing), list, scores, detail, end (report + memories), PDF, steps; sessions; `DELETE /v1/me`; dashboard/report/debug pages | #15 | `ROUTE_INTERVIEWS` | 116 | 133 | 7 / 7 | merged. Adds the Gemini provider and the cost guard, now metering résumé, report, memory and embedding calls (the web didn't). Document indexing moved here from route 7 (creation needs it). Fixed the debug page's user-id bug |
| 4 | plain chat SSE (`POST /v1/chat`) | #16 | `ROUTE_CHAT` | 130 | 138 | 8 / 8 | merged. Chat is now metered. Fixed: a client disconnect left the model stream open until GC; the dashboard crashed with all flags on `next` and no API configured (CI's `next` run now has no API) |
| 5 | agent loop + 6 tools (`POST /v1/interviews/{id}/turns`) | #17 | `ROUTE_AGENT` | 147 | 143 | 9 / 9 | merged. Explicit tool registry; each tool in a savepoint; evaluation calls metered. Fixed: résumé answers couldn't be evaluated (UUID-only ids) and lost their question text; live voice sessions declared no tools (web) |
| 6 | voice session + tool bridge (`POST /v1/voice/sessions`, `.../{id}/tool-calls`, `.../{id}/usage`) | #18, #19 | `ROUTE_VOICE` | 167 | 154 | 10 / 10 | #18 merged: the Live setup frame sent bare declarations as `setup.tools` (Gemini expects `[{functionDeclarations}]`). #19: Alembic `0002` adds `voice_sessions` and `voice_tool_calls` (expand-only). Tool calls and usage are keyed by a server-issued session id that fixes the user and interview; a retried `call_id` replays the stored result. Tool and usage tokens are metered and usage is kept per session. Without a Gemini key no session can start, so E2E covers the error paths; the happy path is covered by API and web tests. Locked tokens (Q2) and a duration floor (Q1) need a paid live session |
| 7 | RAG ingestion | | `ROUTE_RAG` | | | | |
| M4 | remove server code from web; flags default `fastapi` | | | | | | |

## Shared machinery (added with route 1)

- `apps/web/src/lib/route-flags.ts` (`routeTarget`) and `api-server.ts` (`apiFor(userId)`: the typed client plus a fresh token).
- Every database is migrated by Alembic (`scripts/alembic-upgrade.mjs`): `db:migrate`, the web test setup, the evals.
- CI starts the real API with an ephemeral key pair and runs E2E twice (flags `next`, then moved routes `fastapi`).
- API rate limiting (`core/rate_limit.py`): Upstash in production, in-memory otherwise; same buckets as the web app.
