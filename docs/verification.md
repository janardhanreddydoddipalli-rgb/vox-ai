# Verification log

What has been verified, how, and what is still open. Each entry is marked **VERIFIED**, **PARTIAL**, **FAILED** or **NOT TESTED**. Never claim more than the evidence shows.

## Open questions

| # | Question | Why it matters | Verify when | Status |
|---|---|---|---|---|
| Q1 | Does Gemini Live's `usageMetadata` report **per turn** or a **running total** for the session? | `live-voice.ts` forwards each frame to `/api/voice/usage`, which **adds** it to the daily ledger. If it's a running total, usage is over-counted. | M3, against a real Live session with the exact model in use (log a few frames and compare against the prompt and response sizes) | NOT TESTED |
| Q2 | Can ephemeral tokens lock the model, system instruction and tools for our Live model (`liveConnectConstraints`)? | Today the browser sends the setup frame, so it could change the prompt or tools. If tokens can't lock them, the fallback is a server-side WebSocket relay (needs its own ADR). | M3, when the voice route moves | NOT TESTED |
| Q3 | Does `gemini-embedding-001` return 768 dimensions with `outputDimensionality: 768`, and does recall work end to end? | Before `23708e3`, every embedding call failed the dimension check, so memory and RAG never worked. | Next session with a real key: one `embedTexts` call, then one interview with memory recall | NOT TESTED (mocked test only) |

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
