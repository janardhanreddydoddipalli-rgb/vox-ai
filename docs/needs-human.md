# Needs a human

Things the migration can't do on its own: production, secrets, paid API calls, or decisions. Kept current during M3–M4.

| # | What | Why it needs you | Since |
|---|---|---|---|
| 1 | Rotate the Gemini API key (it was pasted in chat) and enable billing on its project | Secret; billing | M0 |
| 2 | Delete the old Neon project in Ohio (empty; its password was exposed) | Production account | M2 |
| 3 | Delete `C:\Users\reddy\package-lock.json` | Your machine, outside the repo | M0 |
| 4 | Stamp Neon production with Alembic `0001` (`docs/runbooks/alembic-cutover.md`) | Production DB, deferred to M5 by decision | M2 |
| 5 | Deploy API (Cloud Run `asia-southeast1`) and web (Vercel `sin1`), with per-environment JWT keys and `INTERNAL_API_TOKEN` | Production + secrets, M5 | M2 |
| 6 | The real-model checks (evals, `@real-model` E2E) were never run against the migrated routes | Paid API calls | M3 |
| 7 | One real live-voice session, with `ROUTE_VOICE` on `next` and then `fastapi`: it connects (checks the #18 setup fix), a tool call works, and a few `usageMetadata` frames are logged for `docs/verification.md` Q1 | Paid Gemini Live calls | M3 |
| 8 | Decide on locking ephemeral tokens (Q2): try `liveConnectConstraints` on a real session; if it can't lock prompt and tools, a server-side WebSocket relay needs an ADR | Paid calls, then an architecture decision | M3 |
