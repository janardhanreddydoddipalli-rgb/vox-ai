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
E2E_TEST_AUTH=1 GEMINI_API_KEY=... DATABASE_URL=... AUTH_SECRET=... npm start
BASE_URL=http://127.0.0.1:3000 RUNS=5 node scripts/measure-latency.mjs
```

Each run is 1 opening turn plus 3 answers, then the report, so `RUNS=5` gives 20 turn samples and 5 report samples. The script warns when no turn used the real model; numbers from that run are not a baseline. Paste the JSON output into the table below, with the date, model and machine.

## Baseline (pre-M1)

| Metric | p50 | p95 | n | Status |
|---|---|---|---|---|
| Time to first token | — | — | — | NOT MEASURED |
| Turn total | — | — | — | NOT MEASURED |
| Report generation | — | — | — | NOT MEASURED |
| Time to first audio (live) | — | — | — | NOT MEASURED |

**Why it's empty:** the M0 work ran in an environment without a `GEMINI_API_KEY`. The harness was checked mechanically on 2026-11-21 (sign-in, interview start and SSE parsing against a local dev server); it stopped at the model call as expected without a key. **Owner:** run the commands above once with a real key, before M1 merges, and fill in the table.

The only earlier figures are anecdotal ones from the README's device-testing table (first audio about 0.6–1.2 s on Chrome desktop, about 0.8–1.5 s on Android). They weren't measured with this method, so they aren't a baseline.
