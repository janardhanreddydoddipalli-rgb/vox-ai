# Architecture

## Current state (M4, verified 2026-11-22; not deployed yet)

The web app is UI only. The browser signs in through Auth.js, gets a 5-minute API token from the web app, and calls `services/api` directly for all data, AI, RAG and voice tooling.

```
Browser (apps/web pages: Next.js 15)
  │ ① Auth.js cookie → GET /api/token (Next) → 5-min EdDSA JWT (sub = users.id)
  │ ② HTTPS REST + SSE, Authorization: Bearer   ③ WebSocket audio straight to Gemini Live
  ▼                                                (ephemeral token from POST /v1/voice/sessions)
services/api (FastAPI, Python 3.12) ── mints token ──►  Gemini Live
 ├─ api/v1         Pydantic in/out, RFC 9457 errors       │ toolCall, usageMetadata (relayed by the browser)
 ├─ core           settings, JWT verify (public key), CORS ▼
 ├─ services       agent turns, chat, reports, memory,  ◄── POST /v1/voice/sessions/{id}/tool-calls
 │                 cost guard, voice sessions              POST /v1/voice/sessions/{id}/usage
 ├─ agent          explicit tool registry, bounded loop (5 tool rounds), savepoint per tool
 ├─ rag            ingest → chunk → embed → hybrid retrieve (vector + FTS, RRF)
 ├─ llm            provider protocol: Gemini | Fake (CI), ephemeral Live tokens
 └─ repositories   user-scoped queries ── Postgres 18 + pgvector 0.8 on Neon (Alembic)

apps/web server code (all of it):
 ├─ /api/auth/*    Auth.js (Google only); at sign-in → POST /internal/users/upsert (service credential)
 ├─ /api/token     mints the browser's API token (private key never leaves the web env)
 └─ server pages   dashboard, report, settings, debug: read the API with a minted token
```

| Concern | Where it lives |
|---|---|
| Auth | Auth.js v5, Google OAuth, JWT sessions (ADR 0002). At sign-in the web resolves `users.id` through `/internal/users/upsert` and keeps it in the session; `GET /api/token` mints 5-min EdDSA JWTs for it (ADR 0004). The API verifies with the public key only. |
| Data access | `services/api` repositories; every user-scoped query filters by user id, and every `{id}` route has a cross-user 404 test (a CI guard enforces it). |
| Migrations | **Alembic** (`services/api/alembic`): baseline `0001` = the old Drizzle 0000–0008 schema (pinned by a test), `0002` voice sessions, `0003` embedding model per row and full-text search. Neon production matches the baseline and is **not yet stamped** (`docs/runbooks/alembic-cutover.md`). |
| AI | Gemini text model for the agent, scoring, reports and memory; Gemini Live for voice; `gemini-embedding-001` (768 dims) for memory/RAG. Only services/api holds the key. |
| Rate limiting | services/api: Upstash Redis in production, in-memory fallback; per-route, per-user buckets |
| Cost guard | Per-user daily token budget (`token_usage`) on every paid path: chat, agent tools, embeddings, reports, live voice (per voice session), evals |
| Observability | Sentry in both apps (ids and metrics only) |
| Hosting | Database: Neon Singapore. Web and API: **not deployed** with M3/M4 yet. Planned: Vercel `sin1` for the web app, Cloud Run `asia-southeast1` for the API image (ADR 0005). |
| CI | `ci.yml`: lint, typecheck, API-client drift, web unit tests, build, then E2E against the real API on a freshly migrated database. `api.yml`: ruff, mypy --strict, pytest (Postgres 18 + pgvector), OpenAPI drift, `alembic upgrade` + `alembic check`, Docker build + smoke. Evals are manual (`evals.yml`). All on Postgres 18.7 / pgvector 0.8.7, like Neon. |

Not built yet (the rules mark them *target*): a per-state tool allowlist for the interview state machine, Live tokens that lock the model, prompt and tools (needs a paid session, `docs/verification.md` Q2), background workers (arq + Redis) for summaries and embeddings, and Langfuse tracing in the API (`docs/backlog.md`).

## Migration path

| Step | What | Done when |
|---|---|---|
| M0 ✅ | Security, cost, data-integrity and CI hotfixes | Merged (#1) |
| M1 ✅ | pnpm monorepo, `apps/web`, docs, compose, pre-commit | Merged (#3) |
| M2 ✅ | `services/api` skeleton: config, logging, errors, JWT auth, health, Alembic baseline matching the Drizzle schema (with `CREATE EXTENSION vector`) | Merged (#10) |
| M3 ✅ | Routes moved one at a time behind `ROUTE_*` flags: memories → turns → interviews/report/PDF → chat SSE → agent + tools → voice session + tool bridge → RAG | Merged (#13–#20); each move kept E2E green in both flag modes |
| M4 ✅ | Flags default to the API; evals and seeding move to the API; the browser calls the API directly; Drizzle and all web server code removed | Merged (#21–#23) |
| M5 | Stamp Neon with Alembic `0001` and upgrade, deploy the API (Cloud Run, ADR 0005), then the web; contract migrations after the old web is gone | `docs/needs-human.md` |

Rules: see `CLAUDE.md`. Decision record: `docs/adr/0001-monorepo-and-fastapi.md`. Per-PR detail: `docs/progress.md`.

## Repository layout

```
vox/
├── apps/web/              Next.js UI: src/ (app, lib, voice, types), tests/ (unit), e2e/, scripts/
│   └── package.json       @vox/web
├── services/api/          FastAPI service (uv): src/vox_api, alembic/, tests/, evals/, scripts/
├── packages/api-client/   @vox/api-client: openapi.json + generated TS types + client
├── docs/                  architecture, ADRs, security, metrics, verification, backlog, runbooks
├── .github/               CI (ci.yml web + E2E, api.yml), manual evals (evals.yml), dependabot
├── compose.yaml           local Postgres 18 (pgvector) + Redis; API under profile "api"
├── infra/                 docker/api.Dockerfile, postgres/ init SQL
├── Makefile               one command per target (web: pnpm, API: uv)
├── package.json           root "vox": web scripts delegate to @vox/web; db scripts run the API's tools
└── pnpm-workspace.yaml    apps/*, packages/*; allowBuilds
```
