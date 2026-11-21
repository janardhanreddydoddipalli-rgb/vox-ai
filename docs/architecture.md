# Architecture

## Current state (M1, verified 2026-11-22)

Vox is one Next.js 15 app inside a pnpm monorepo:

```
Browser
  │ HTTPS: pages, REST, SSE (/api/chat)        │ WebSocket: PCM audio (Gemini Live,
  ▼                                            ▼  ephemeral token from /api/voice/session)
apps/web (Next.js App Router)  ───────────►  Gemini API (generateContent, Live, embeddings)
 ├─ src/app/            pages + API routes (auth, chat, interviews, voice/session|tool|usage, memories, turns)
 ├─ src/agent/          bounded function-calling loop, tools, report, memory, interview state
 ├─ src/lib/db/         Drizzle schema + repository (all DB access; user-scoped)
 ├─ src/lib/            auth (Auth.js, Google-only), rate limit (Upstash/in-memory), cost guard,
 │                      embeddings, tracing (Langfuse), observability (Sentry)
 └─ src/voice/          browser voice engine: Gemini Live → Web Speech → text fallback
        │
        ▼
Postgres 18 + pgvector 0.8 on Neon (Singapore, ap-southeast-1)
```

| Concern | Where it lives today |
|---|---|
| Auth | Auth.js v5, Google OAuth, JWT sessions (ADR 0002) |
| Data access | `apps/web/src/lib/db/repository.ts`; every user-scoped query filters by user id |
| Migrations | Drizzle SQL in `apps/web/drizzle` (0000–0008), applied by `scripts/migrate.mjs` (creates pgvector first) |
| AI | Gemini text model for the agent, scoring, reports and memory; Gemini Live for voice; `gemini-embedding-001` (768 dims) for memory/RAG |
| Rate limiting | Upstash Redis in production, in-memory fallback; per-route buckets |
| Cost guard | Per-user daily token budget (`token_usage`); text and live paths both record usage |
| Observability | Sentry (ids only), Langfuse traces (metadata only) |
| Hosting | Database: Neon Singapore (migrated and seeded). App: **not deployed yet**. Planned: Vercel with Root Directory `apps/web` and function region `sin1`, beside the database. |
| CI | `.github/workflows/ci.yml`: lint, typecheck, migrate on an empty DB, unit/API tests, build, E2E smoke. Evals are manual (`evals.yml`). |

## Target (after M4)

```
Browser (apps/web: Next.js, UI only)
  │ ① Auth.js cookie → GET /api/token (Next) → 5-min EdDSA JWT (sub = user uuid)
  │ ② HTTPS REST + SSE, Authorization: Bearer   ③ WebSocket audio (ephemeral token,
  ▼                                                model/prompt/tools locked server-side)
services/api (FastAPI) ────── mints token ──────►  Gemini Live
 ├─ api/v1         Pydantic in/out, RFC 9457 errors      │ toolCall, usageMetadata
 ├─ core/security  JWT verify (public key), request id    ▼
 ├─ services       interview state machine ◄── POST /v1/voice/sessions/{id}/tool-calls
 │                 cost guard, reports, deletion          POST /v1/voice/sessions/{id}/usage
 ├─ agent          tool registry, bounded loop, per-state tool allowlist
 ├─ rag            ingest → chunk → embed → hybrid retrieve (vector + FTS, RRF)
 ├─ llm            provider interface: Gemini | Fake (CI)
 ├─ workers (arq)  summaries, embeddings ── Redis
 └─ repositories   user-scoped queries ── Postgres + pgvector (Alembic)
```

Rules: see `CLAUDE.md`. Decision record: `docs/adr/0001-monorepo-and-fastapi.md`.

## Migration path

| Step | What | Done when |
|---|---|---|
| M0 ✅ | Security, cost, data-integrity and CI hotfixes | Merged (#1) |
| M1 ✅ (this PR) | pnpm monorepo, `apps/web`, docs, compose, pre-commit | App unchanged from the new layout; all checks green |
| M2 | `services/api` skeleton: config, logging, errors, JWT auth, health, Alembic baseline matching the Drizzle schema (must `CREATE EXTENSION vector`) | Both run with `make dev`; API CI green; empty schema diff |
| M3 | Move routes one at a time behind `ROUTE_*` flags: memories → turns → interviews/report/PDF → chat SSE → agent + tools → voice session + tool bridge → RAG ingestion | Each move keeps E2E green and latency within budget |
| M4 | Remove Drizzle and server code from web; generate the API client | Web holds no DB code; docs match reality |

## Repository layout

```
vox/
├── apps/web/              Next.js app (everything today)
│   ├── src/ tests/ e2e/ evals/ scripts/ drizzle/ public/
│   └── package.json       @vox/web
├── docs/                  architecture, ADRs, security, metrics, verification, backlog
├── .github/               CI (ci.yml), manual evals (evals.yml), dependabot
├── compose.yaml           local Postgres (pgvector) + Redis
├── infra/postgres/        compose init SQL
├── Makefile               one pnpm command per target
├── package.json           root "vox": scripts delegate to @vox/web
└── pnpm-workspace.yaml    apps/*, packages/*; allowBuilds
```
