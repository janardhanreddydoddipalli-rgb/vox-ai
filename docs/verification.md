# Verification log

What has been verified, how, and what is still open. Each entry is marked **VERIFIED**, **PARTIAL**, **FAILED** or **NOT TESTED**. Never claim more than the evidence shows.

## Open questions

| # | Question | Why it matters | Verify when | Status |
|---|---|---|---|---|
| Q1 | Does Gemini Live's `usageMetadata` report **per turn** or a **running total** for the session? | `live-voice.ts` forwards each frame to `POST /v1/voice/sessions/{id}/usage`, which **adds** it to the daily ledger (and the session's totals). If it's a running total, usage is over-counted. | M3, against a real Live session with the exact model in use (log a few frames and compare against the prompt and response sizes) | NOT TESTED |
| Q2 | Can ephemeral tokens lock the model, system instruction and tools for our Live model (`liveConnectConstraints`)? | Today the browser sends the setup frame, so it could change the prompt or tools. If tokens can't lock them, the fallback is a server-side WebSocket relay (needs its own ADR). | M3. The voice route moved in #19 with unlocked tokens (the same as the web); locking needs a paid session (`docs/needs-human.md` #8) | NOT TESTED |
| Q3 | Does `gemini-embedding-001` return 768 dimensions with `outputDimensionality: 768`, and does recall work end to end? | Before `23708e3`, every embedding call failed the dimension check, so memory and RAG never worked. | 2026-11-21, real API (see below) | **VERIFIED** for embeddings. End-to-end recall inside an interview: NOT TESTED (Gemini quota, Q4) |
| Q4 | Which Gemini tier does **production** use? | The dev key is on the **free tier: 20 `generateContent` requests per day per model** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`; `gemini-3.5-flash` counts against `gemini-3.6-flash`). One interview uses roughly 10–20 requests (agent tool rounds, evaluation, report, memory summary), so a free-tier production key would run out after one or two interviews a day. | Before launch: check the plan of the production key's project in AI Studio | NOT TESTED |

### Q3 evidence (2026-11-21, real API, key read from `.env.local`)

```
old request (no outputDimensionality): dims=3072 norm=1.0000
fixed embedTexts: count=2 dims=768,768 norms=1.000000,1.000000
fixed embedText (query): dims=768 norm=1.000000
relevance sanity: sim(query, pooling doc)=0.736 > sim(query, react doc)=0.565 -> true
```

- The first line confirms the original bug: the API's default is 3072 dimensions, so the old 768 check threw on every call.
- The fixed path returns 768-dimension unit vectors.
- Relevance is sensible: the pooling query ranks the pooling document above the React document.

## Requirements for M2 (Alembic baseline)

- **The first Alembic migration must run `CREATE EXTENSION IF NOT EXISTS vector` before any table that uses `vector(768)`.** No Drizzle migration does this: `0005_pgvector-memory.sql` assumes the extension exists, so any fresh database fails at `CREATE TABLE doc_chunks`. Until M2, `npm run db:migrate` (`scripts/migrate.mjs`), `tests/setup.ts` and `evals/run.ts` each create it before migrating.
- The baseline must include migration `0008` (unique `interview_qa(interview_id, order)`).

## M0 hotfixes

| Item | Commit | Evidence | Status |
|---|---|---|---|
| Interview ownership in `/api/voice/tool` and all tools | `1694ec7` | 5 cross-user tests failed before the fix (user B received user A's résumé), passed after | VERIFIED |
| Upstash rate limiter connected, per-route limits | `db906f6` | 4 of 5 tests failed before the fix; passed after (mocked Upstash) | VERIFIED (mocked) |
| Live-voice usage recorded; over-budget sessions stopped | `55ff4a3` | Over-budget tool call returned `ok: true` before the fix; passed after | PARTIAL (see Q1) |
| Separate voice rate-limit buckets keyed by user id | `c2381aa` | 3 failed before, passed after | VERIFIED |
| Embeddings: 768 dimensions, task type, normalised | `23708e3` | 3 failed before, passed after | PARTIAL (see Q3) |
| Unique answer order | `332456e` | 6 concurrent saves all got order 0 before the fix; migration renumbered `0,0,0,1,3 → 0,1,2,3,4` on a scratch DB | VERIFIED |
| Google-only sign-in | `0299588` | Provider list was `[google, resend]` before the fix, `[google]` after | VERIFIED |
| No transcript text in logs; language validated | `e9b103e` | 4 failed before, passed after | VERIFIED |

## M2: FastAPI skeleton (2026-11-22)

| Item | Evidence | Status |
|---|---|---|
| Postgres 18.7 + pgvector 0.8.7 in compose and CI (= Neon) | Image checked; web suite, migrate and E2E pass on it | VERIFIED |
| Alembic baseline = Drizzle 0000–0008 | `pg_dump --schema-only` of a Drizzle-built DB vs an Alembic-built DB: **empty diff** (only pg_dump's random `\restrict` token lines differ). Pinned in CI by `test_schema_baseline.py`, which was shown to fail on a one-character default change | VERIFIED |
| Neon production matches Drizzle 0000–0008 | `scripts/verify_drizzle_schema.py`, read-only: columns 77, constraints 86, indexes 23, extensions 2, all identical | VERIFIED (not stamped yet) |
| `alembic check` (models = migrations) | "No new upgrade operations detected." | VERIFIED |
| Web-minted token accepted by the API | Token from `apps/web/src/lib/api-token.ts` → running uvicorn `/v1/me` 200; one char flipped → 401 | VERIFIED |
| Internal upsert from the web code | `upsertUserViaApi` twice → same id; wrong credential → 401 | VERIFIED |
| API image | 79 MB, uid 10001, health/ready OK, `alembic current` in the image, Docker HEALTHCHECK healthy | VERIFIED (locally) |
| `make` targets | `make` isn't installed on the dev machine; every underlying command was run directly | PARTIAL |

## M3–M4: routes moved, web server code removed (2026-11-22)

| Item | Evidence | Status |
|---|---|---|
| Each moved route behaves the same on the API | E2E green with the route on `next` and on `fastapi`, locally and in CI, for every M3 PR (#13–#20); M4.1 (#21) ran the default and the full rollback | VERIFIED |
| Cross-user access is 404 on every `{id}` route | `tests/security/test_cross_user.py`; the route-ownership guard fails CI on an unregistered `{id}` route | VERIFIED |
| Voice tool calls: server-issued session, idempotent per `call_id` | API tests: a retried call runs the tool once (one model call, one answer row); another tool under the same `call_id` is 409; foreign sessions are 404 | VERIFIED (API tests) |
| Live setup frame wraps tools in `functionDeclarations` (#18) | Unit test failed on the old shape, passes now | PARTIAL (no real Live session: paid) |
| A real live-voice session end to end (connect, tool call, usage) | Needs paid Gemini Live calls (`docs/needs-human.md` #7) | NOT TESTED |
| Hybrid retrieval (vector + full-text, RRF) and same-model filtering | `tests/test_rag.py` on deterministic fake embeddings: an exact term ranks first, other users' and other models' rows never compared | VERIFIED (fake embeddings) |
| Evals ported to Python | Pure checks unit-tested; one case runs end to end on the fake provider in CI | PARTIAL (never run on the real model: paid) |
| Browser calls the API directly (token from `/api/token`, CORS) | E2E: start, end, report, PDF download, settings delete and account deletion all go browser → API | VERIFIED (E2E, local and CI) |
| Web app has no database, model or rate-limit access | Drizzle, the agent and every server module deleted; the build lists only `/api/auth/*` and `/api/token` as server routes | VERIFIED |
| Real-model E2E (`@real-model`) and the latency baseline | Paid calls / billing | NOT TESTED / DEFERRED |
