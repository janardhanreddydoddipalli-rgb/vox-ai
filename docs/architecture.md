# Architecture

## Current state (M2, verified 2026-11-22)

The product still runs entirely in the Next.js 15 app. `services/api` (FastAPI) is up beside it, but **no route has moved yet**: it serves only health, `/v1/me` and the internal user upsert, and nothing calls it in production.

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
        ▲
        │ (same tables; route-free in M2)
services/api (FastAPI, Python 3.12)
 ├─ core/           settings (fail fast), JSON logs + request_id, RFC 9457 errors, CORS, Sentry
 ├─ core/security   EdDSA JWT verify (public key only), service credential
 ├─ api/v1          /health, /health/ready, /me      api/internal  /users/upsert (hidden)
 ├─ models/         every table, matching Drizzle 0000-0008 exactly
 ├─ llm/            LLMProvider protocol + deterministic FakeProvider
 └─ alembic/        baseline 0001 = Drizzle schema + pgvector
```

| Concern | Where it lives today |
|---|---|
| Auth | Auth.js v5, Google OAuth, JWT sessions (ADR 0002). `GET /api/token` mints 5-min EdDSA JWTs for the API (ADR 0004); `AUTH_UPSERT_VIA_API` (off) resolves user ids through the API at sign-in. |
| Data access | `apps/web/src/lib/db/repository.ts`; every user-scoped query filters by user id |
| Migrations | **Alembic** (`services/api/alembic`) from M2; baseline `0001` = Drizzle 0000–0008 (empty `pg_dump` diff, pinned by a test). Drizzle is **frozen** (a test fails on 0009). Neon production matches Drizzle exactly (verified read-only) and is **not yet stamped**; see `docs/runbooks/alembic-cutover.md`. |
| AI | Gemini text model for the agent, scoring, reports and memory; Gemini Live for voice; `gemini-embedding-001` (768 dims) for memory/RAG |
| Rate limiting | Upstash Redis in production, in-memory fallback; per-route buckets |
| Cost guard | Per-user daily token budget (`token_usage`); text and live paths both record usage |
| Observability | Sentry (ids only), Langfuse traces (metadata only) |
| Hosting | Database: Neon Singapore (migrated and seeded). Web and API: **not deployed yet**. Planned: Vercel `sin1` for the web app, Cloud Run `asia-southeast1` for the API image (ADR 0005). |
| CI | `ci.yml` (web): lint, typecheck, API-client drift, migrate on an empty DB, tests, build, E2E smoke. `api.yml`: ruff, mypy --strict, pytest (Postgres 18 + pgvector), OpenAPI drift, `alembic upgrade` + `alembic check`, Docker build + smoke. Evals are manual (`evals.yml`). All on Postgres 18.7 / pgvector 0.8.7, like Neon. |

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
| M1 ✅ | pnpm monorepo, `apps/web`, docs, compose, pre-commit | Merged (#3) |
| M2 ✅ (this PR) | `services/api` skeleton: config, logging, errors, JWT auth, health, Alembic baseline matching the Drizzle schema (with `CREATE EXTENSION vector`) | API CI green; empty schema diff; web token accepted by the API end to end |
| M3 | First: stamp Neon with Alembic `0001` (runbook), deploy the API (ADR 0005). Then move routes one at a time behind `ROUTE_*` flags: memories → turns → interviews/report/PDF → chat SSE → agent + tools → voice session + tool bridge → RAG ingestion | Each move keeps E2E green and latency within budget |
| M4 | Remove Drizzle and server code from web; generate the API client | Web holds no DB code; docs match reality |

## Repository layout

```
vox/
├── apps/web/              Next.js app (the whole product today)
│   ├── src/ tests/ e2e/ evals/ scripts/ drizzle/ (frozen) public/
│   └── package.json       @vox/web
├── services/api/          FastAPI service (uv): src/vox_api, alembic/, tests/, scripts/
├── packages/api-client/   @vox/api-client: openapi.json + generated TS types + client
├── docs/                  architecture, ADRs, security, metrics, verification, backlog
├── .github/               CI (ci.yml web, api.yml), manual evals (evals.yml), dependabot
├── compose.yaml           local Postgres 18 (pgvector) + Redis; API under profile "api"
├── infra/                 docker/api.Dockerfile, postgres/ init SQL
├── Makefile               one command per target (web: pnpm, API: uv)
├── package.json           root "vox": scripts delegate to @vox/web
└── pnpm-workspace.yaml    apps/*, packages/*; allowBuilds
```
