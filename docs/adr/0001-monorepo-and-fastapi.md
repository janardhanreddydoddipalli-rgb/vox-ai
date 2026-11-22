# ADR 0001: pnpm monorepo, with a FastAPI backend migrated in route by route

- Status: Accepted (implemented: M1 monorepo, M2 API skeleton, M3 routes #13–#20, M4 web server code removed #21–#23)
- Date: 2026-11-21

## Context

Vox started as a single Next.js app that does everything: UI, API routes, database access through Drizzle, and the Gemini agent, voice and RAG code. Three things push it apart:

- **AI and RAG work.** Retrieval, evals, background jobs (summaries, embeddings) and model experimentation have stronger tooling and libraries in Python.
- **Clear trust boundaries.** The M0 audit found authorization and cost bugs at the edges where the browser talks to server code (the voice tool bridge, client-reported usage). One backend that owns all data and AI makes the boundary explicit: the web app only renders and authenticates.
- **Independent scaling and hosting.** Long SSE and voice-related requests suit a container host better than serverless functions.

A rewrite that replaces everything at once would stop feature work and risk regressions in a working product.

## Decision

1. **Monorepo (pnpm workspace).** `apps/web` holds the Next.js app, `services/api` (from M2) the FastAPI service, and `packages/` shared code such as the generated API client. One repo, one CI, atomic cross-cutting changes.
2. **FastAPI owns business logic, data and AI** (done in M4): Python 3.12, SQLAlchemy 2 async, Alembic, Pydantic v2. Next.js keeps only UI, Auth.js and token minting.
3. **Strangler migration.** Routes move one at a time (M3), each behind a `ROUTE_*` flag so rollback is a config change. Tests are ported first, then traffic switches, then the TS route is deleted. In M4 the flags defaulted to the API (#21), then the TS routes and the flags were removed and the browser calls the API directly (#23).
4. **One migration owner.** Drizzle until the M2 Alembic baseline, then Alembic only. The baseline must reproduce the current schema exactly, including `CREATE EXTENSION vector` (`docs/verification.md`).
5. **Auth between web and API:** a short-lived EdDSA JWT minted by the web app and verified by the API with the public key (details in a separate ADR at M2).

## Consequences

- During M3, two codebases share one database. Schema changes must be expand/contract, and both sides need tests.
- Each moved route must keep the E2E smoke test green. Latency stays within the agreed budget (`docs/metrics.md`; the numeric baseline is deferred until Gemini billing is on).
- Two languages and toolchains (pnpm and uv) in one repo. Mitigated by the root `Makefile` and per-language CI workflows.
- **Alternatives rejected:**
  - Staying a single Next.js app: weakest trust boundaries and AI tooling.
  - A big-bang rewrite: too risky for a working product.
  - Separate repos: cross-cutting changes like auth and the API client become multi-repo coordination.
