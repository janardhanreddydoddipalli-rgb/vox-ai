# Metrics and latency baseline

The M3 rule for every route move: **latency must be no worse than this baseline plus the agreed margin.** The margin gets set once real numbers exist (proposal: +150 ms at p95 for time to first token).

## What we measure

| Metric | Definition | How |
|---|---|---|
| Time to first token (text) | `POST /api/chat` sent → first SSE `token` event | `scripts/measure-latency.mjs` |
| Turn total (text) | `POST /api/chat` sent → SSE `done` | `scripts/measure-latency.mjs` |
| Report generation | `POST /api/interviews/{id}/end` sent → response | `scripts/measure-latency.mjs` |
| Time to first audio (live voice) | User stops speaking → first model audio plays | By hand: the latency pill on the interview page, 10 turns, Chrome desktop |

## How to run the text baseline

Run it locally against a seeded test database and a real key. **Never against production**: the script refuses non-local URLs and signs in through the E2E test provider.

```bash
npm run build
npx tsx scripts/seed-questions.ts                      # with DATABASE_URL set
E2E_TEST_AUTH=1 AUTH_TRUST_HOST=true DAILY_TOKEN_BUDGET=0 DATABASE_URL=... AUTH_SECRET=... npm start   # key from .env.local
BASE_URL=http://127.0.0.1:3000 RUNS=5 node scripts/measure-latency.mjs
```

Notes on the server flags:
- `AUTH_TRUST_HOST=true` is required for `next start` outside Vercel. Without it, Auth.js answers every auth request with `UntrustedHost`, and Vercel sets it automatically.
- `DAILY_TOKEN_BUDGET=0` stops the local cost guard from cutting the run short.

**Quota:** `RUNS=5` needs about 80+ `generateContent` requests. The free tier allows **20 per day per model**, so a baseline needs a paid-tier key, or `RUNS=1` on a fresh free-tier day (about 15–20 requests, which is too few samples for a meaningful p95).

Each run is 1 opening turn plus 3 answers, then the report, so `RUNS=5` gives 20 turn samples and 5 report samples. The script warns when no turn used the real model; numbers from that run are not a baseline. Paste the JSON output into the table below, with the date, model and machine.

## Baseline (pre-M1)

| Metric | p50 | p95 | n | Status |
|---|---|---|---|---|
| Time to first token | — | — | — | DEFERRED |
| Turn total | — | — | — | DEFERRED |
| Report generation | — | — | — | DEFERRED |
| Time to first audio (live) | — | — | — | DEFERRED |

**Why it's still empty:**
- The harness was checked mechanically on 2026-11-21 against a local dev server with no key (sign-in, interview start and SSE parsing all worked).
- A real run on 2026-11-21 against a local production build reached the model, which answered `429 RESOURCE_EXHAUSTED`: the key is on the free tier, 20 `generateContent` requests per day, already used up.

**Status: DEFERRED (decided 2026-11-21).** Gemini billing is postponed, so there is no paid-tier key yet. The baseline will be run once billing is on and the key is rotated (`docs/verification.md` Q4). Until then, the M3 rule "no worse than baseline" can't be checked numerically. Each M3 route move must instead note the time to first token from the UI latency pill on the same machine, before and after the move.

The only earlier figures are anecdotal ones from the README's device-testing table (first audio about 0.6–1.2 s on Chrome desktop, about 0.8–1.5 s on Android). They weren't measured with this method, so they aren't a baseline.
