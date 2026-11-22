# ADR 0003: FastAPI backend stack (services/api)

- Status: Accepted (skeleton in M2; every route by M4)
- Date: 2026-11-22
- Builds on: ADR 0001 (monorepo, strangler migration)

## Context

ADR 0001 decided that business logic, data and AI move from the Next.js app to a Python service, one route at a time. M2 builds that service's skeleton without moving any route. The choices below are the dependencies CLAUDE.md requires an ADR for.

## Decision

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Python 3.12**, pinned via `.python-version` | Mature async ecosystem; uv downloads it per project, so system Python (3.13 here) is untouched |
| Packaging | **uv** (`pyproject.toml` + `uv.lock`) | One fast tool for Python versions, venvs and an exact lockfile; `uv sync --frozen` in CI and Docker |
| Web framework | **FastAPI** + **uvicorn** | Pydantic v2 validation at every boundary, async, OpenAPI out of the box (feeds the TS client) |
| Settings | **pydantic-settings** | Typed env config that fails at startup when a required value is missing |
| Database | **SQLAlchemy 2 async** + **asyncpg** + **pgvector** | Typed ORM and Core; asyncpg is the fastest Postgres driver. Prepared-statement cache off for Neon's PgBouncer |
| Migrations | **Alembic** (only tool from M2) | Baseline `0001` reproduces Drizzle 0000–0008 exactly (empty `pg_dump` diff; pinned by a test) |
| Auth | **PyJWT[crypto]**, EdDSA only | See ADR 0004 |
| Logging | **structlog**, JSON, `request_id` on every line | Searchable logs; bodies never logged |
| Errors | RFC 9457 `application/problem+json` | One error shape for every client; validation errors never echo input |
| Monitoring | **sentry-sdk** | User id only; bodies, cookies and auth headers scrubbed |
| LLM | Own `LLMProvider` protocol + `FakeProvider` | CI stays deterministic and offline; Gemini provider in M3 |
| Quality | **ruff** (lint + format), **mypy --strict**, **pytest** + **pytest-asyncio**, **testcontainers** (pgvector pg18) | Tests run on the same engine as production (Postgres 18.7, pgvector 0.8.7) |
| TS client | **openapi-typescript** (types) + **openapi-fetch** (very small runtime) in `packages/api-client` | Generated from the exported schema; CI fails on drift in either direction |

## Consequences

- Two toolchains (pnpm and uv). The Makefile gives both one-command targets, and each has its own CI workflow (`web.yml`, `api.yml`; `e2e.yml` covers both, ADR 0006).
- Schema changes go through Alembic only. Drizzle was removed in M4 (its migrations stay in git history). Existing Drizzle-built databases are **stamped** at `0001` (never built from it) and then upgraded, at the cutover (`docs/runbooks/alembic-cutover.md`).
- During M3, both apps write the same tables, so schema changes must be expand/contract.
- **Rejected alternatives:**
  - Django: heavier, and its ORM and migrations would duplicate Alembic's job.
  - Poetry or pip-tools: slower, and they don't manage the Python version.
  - psycopg 3 instead of asyncpg: viable, but asyncpg is faster and better trodden with SQLAlchemy async.
