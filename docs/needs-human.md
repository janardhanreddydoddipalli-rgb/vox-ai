# Needs a human

Things the migration can't do on its own: production, secrets, paid API calls, or decisions. Kept current during M3–M4.

**Before anything is deployed:** since M4, `main` runs only with services/api beside it. The web app has no database or model access of its own. Deploy in the order in #4–#5. Deploying the web app alone breaks sign-in.

| # | What | Why it needs you | Since |
|---|---|---|---|
| 1 | Rotate the Gemini API key (it was pasted in chat) and enable billing on its project | Secret; billing | M0 |
| 2 | Delete the old Neon project in Ohio (empty; its password was exposed) | Production account | M2 |
| 3 | Delete `C:\Users\reddy\package-lock.json` | Your machine, outside the repo | M0 |
| 4 | Neon production: `alembic stamp 0001`, then `alembic upgrade head` (applies the expand-only `0002`, `0003`). Follow `docs/runbooks/alembic-cutover.md` | Production DB, deferred to M5 by decision | M2 |
| 5 | Deploy in order: (a) the API on Cloud Run `asia-southeast1` with `DATABASE_URL` (Neon pooled), `WEB_ORIGIN` (the production web origin), `JWT_PUBLIC_KEY`, `INTERNAL_API_TOKEN`, `GEMINI_API_KEY`, `UPSTASH_REDIS_REST_*`, `DAILY_TOKEN_BUDGET`, `SENTRY_DSN`; (b) on Vercel, **add** `API_JWT_PRIVATE_KEY`, `API_INTERNAL_URL`, `INTERNAL_API_TOKEN`, `NEXT_PUBLIC_API_URL` and **remove** `DATABASE_URL`, `GEMINI_*`, `UPSTASH_*`, `LANGFUSE_*`, `DAILY_TOKEN_BUDGET`, `CHAT_CONTEXT_TURNS`, `AUTH_UPSERT_VIA_API`, any `ROUTE_*`; (c) deploy the web. One key pair and service token per environment | Production + secrets, M5 | M2 |
| 6 | The real-model checks (evals, `@real-model` E2E) were never run against the API: Actions → "Evals (manual, real model)" | Paid API calls | M3 |
| 7 | One real live-voice session through the web app and the API: it connects (checks the #18 setup-frame fix), a tool call works, and a few `usageMetadata` frames are logged for `docs/verification.md` Q1 | Paid Gemini Live calls | M3 |
| 8 | Decide on locking ephemeral tokens (Q2): try `liveConnectConstraints` on a real session; if it can't lock prompt and tools, a server-side WebSocket relay needs an ADR | Paid calls, then an architecture decision | M3 |
| 9 | After the new web is live and the old one is gone: approve the contract migration that drops the `embedding_model` / `embedding_dim` defaults (`docs/backlog.md`) | Production DB | M4 |
| 10 | Run the latency baseline once billing is on (`docs/metrics.md`) | Paid calls | M0 |
