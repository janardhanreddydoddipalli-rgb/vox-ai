# Verification log

What has been verified, how, and what is still open. Each entry is marked **VERIFIED**, **PARTIAL**, **FAILED** or **NOT TESTED**. Never claim more than the evidence shows.

## Open questions

| # | Question | Why it matters | Verify when | Status |
|---|---|---|---|---|
| Q1 | Does Gemini Live's `usageMetadata` report **per turn** or a **running total** for the session? | `live-voice.ts` forwards each frame to `/api/voice/usage`, which **adds** it to the daily ledger. If it's a running total, usage is over-counted. | M3, against a real Live session with the exact model in use (log a few frames and compare against the prompt and response sizes) | NOT TESTED |
| Q2 | Can ephemeral tokens lock the model, system instruction and tools for our Live model (`liveConnectConstraints`)? | Today the browser sends the setup frame, so it could change the prompt or tools. If tokens can't lock them, the fallback is a server-side WebSocket relay (needs its own ADR). | M3, when the voice route moves | NOT TESTED |
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
