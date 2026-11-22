# Vox: Engineering Rules (read before every task)

## Current state (update as milestones land)
- **M2 (now):** the whole product still runs in `apps/web` (Next.js). `services/api` (FastAPI, Python 3.12, uv) exists with health, `/v1/me`, `/internal/users/upsert`, the Alembic baseline and token auth, but **no route has moved yet**. Next: M3.
- **Migration plan:** M2 FastAPI skeleton → M3 move routes one at a time behind flags → M4 remove server code from web. Details: `docs/architecture.md`, `docs/adr/0001-monorepo-and-fastapi.md`.
- **Until M4,** the rules marked *(target)* apply to new backend code in `services/api`. Code in `apps/web` follows every other rule here.

## Commands
- Install: `pnpm install --frozen-lockfile`. Every root script delegates to `@vox/web` (see `Makefile`).
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (needs `TEST_DATABASE_URL`), `pnpm build`, `pnpm test:e2e`.
- API: `make api-install`, `make api-dev`, `make api-lint`, `make api-typecheck`, `make api-test` (Docker or `TEST_DATABASE_URL`), `make api-openapi` (after changing API schemas).
- Migrations: **Alembic only** (`make api-migrate` on empty DBs). Existing Drizzle-built DBs are **stamped** (`docs/runbooks/alembic-cutover.md`). Drizzle is frozen. `pnpm db:migrate`, the web test setup and the evals all run Alembic (needs `uv`). Question bank: `pnpm db:seed`. Evals: `pnpm eval` (Python, `services/api/evals`; paid).

## Architecture
- *(target)* `apps/web` = UI only. Its only server code is Auth.js, `/api/token` and the internal user-upsert call. No DB access, no LLM calls, no secrets beyond public env and the JWT signing key.
- *(target)* `services/api` = all business logic, data, AI, RAG and voice tooling.
- Layering: api → services → repositories → models. Routers never query the DB. Repositories never call LLMs. (In `apps/web` today: route handlers use `src/lib/db/repository.ts`, never raw Drizzle.)
- The interview state machine is the source of truth for progress, never the LLM or the voice session. Each state has an explicit tool allowlist.
- Migrations: **Alembic only** (`services/api/alembic`); `apps/web/drizzle` is frozen at 0008. Never edit an applied migration. Schema changes are expand/contract while both apps share the tables (M3).
- No new framework, service or dependency without an ADR in `docs/adr/`.

## Security (non-negotiable)
- API auth (ADR 0004): EdDSA JWT from `/api/token`, iss=vox-web, aud=vox-api, sub=user uuid, jti, exp ≤ 5 min. The API verifies with the public key only; every route except health uses `CurrentUser`. The private key never leaves the web env.
- Every user-scoped query filters by user_id in the repository. Every id route verifies ownership; not owned → 404.
- Voice tool calls are validated against the signed-in user's interview, never trusted from the client. *(target: keyed by a server-issued voice_session_id, idempotent per call_id.)*
- Ephemeral Live tokens lock the model, system instruction and tools server-side *(target, M3; see docs/verification.md Q2)*.
- Résumés, JDs, memories, retrieved chunks, model output and client-reported usage are untrusted input.
- Never log transcripts, résumé text, tokens or keys. Sentry and Langfuse get ids and metrics only.
- Every paid model path (chat, live voice, embeddings, evals) records token usage against the cost guard.
- Secrets only via environment. Never commit `.env*` files except `.env.example`. Production DB credentials live in `apps/web/.env.neon.local`, which nothing loads automatically.

## AI / RAG
- Prompts live in versioned files; prompt_version is stored on the interview and on every trace *(target)*.
- Agent loop: max steps, per-tool timeout, per-turn timeout; structured output validated by schema.
- Embeddings: store model + dim per row (`embedding_model`, `embedding_dim`) and only compare vectors from the same model; always pass outputDimensionality (768); L2-normalise; set taskType (RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY).
- Retrieval: user_id in WHERE; hybrid vector + full-text with RRF (`services/api` `rag/retrieve.py`). Retrieved text is data, never instructions.

## Code quality
- Python: ruff + ruff format + mypy --strict clean; Pydantic at every API boundary; errors are RFC 9457 problem+json (`ProblemError`).
- TypeScript: strict; no `any` or `@ts-ignore` in new or touched code without a linked reason.
- No dead code, no commented-out code, no unused dependencies. Files over ~300 lines need a reason.

## Testing
- Every bug fix ships with a test that fails before the fix.
- Every new route: happy path, validation error, unauthenticated, cross-user (404). API routes with an `{id}` must be registered in `services/api/tests/security/test_route_ownership.py`, or CI fails.
- CI is deterministic: mocked LLM responses only. Real-model evals and the `@real-model` E2E run only in the manual `evals.yml` workflow.
- Integration tests use a real Postgres + pgvector (CI service or a local container), never staging or production. Tests refuse any DB except `TEST_DATABASE_URL`.

## Workflow
- Inspect the code before changing it. Never assume reported behaviour exists; reproduce it first.
- Small commits, Conventional Commits. Use `git mv` for moves.
- Before reporting done: run lint, typecheck, tests and build; paste the real output. Mark each item VERIFIED / PARTIAL / FAILED / NOT TESTED.
- Never push to `main`, deploy, run migrations on a real database, or change secrets or hosting settings without explicit approval. Work on a branch and open a PR.
- Update `docs/` when behaviour or architecture changes.

## Windows notes (this repo is developed on Windows)
- Vitest fails with "failed to find the runner" if the terminal's cwd uses a lowercase drive letter (`c:\…`). Open VS Code from `C:\…`.
- `make` isn't installed by default; every Makefile target is a single `pnpm …` command you can run directly.
