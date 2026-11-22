# Vox: Engineering Rules (read before every task)

## Current state (update as milestones land)
- **M4 (done, not deployed):** `apps/web` is the UI: pages, Auth.js, `/api/token` and the internal user upsert. The browser calls `services/api` (FastAPI) directly for everything else. Drizzle, the web agent and every other server module are gone. Next: M5 (stamp Neon, deploy the API, then the web; `docs/needs-human.md`).
- **History:** M2 FastAPI skeleton → M3 routes moved one at a time behind flags → M4 web server code removed. Details: `docs/architecture.md`, `docs/progress.md`, `docs/adr/0001-monorepo-and-fastapi.md`.
- Rules still marked *(target)* are not implemented yet.

## Commands
- Install: `pnpm install --frozen-lockfile` and `make api-install`. Web scripts delegate to `@vox/web`; database scripts run the API's tools (see `Makefile`).
- Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test` (web unit tests, no database), `pnpm build`, `pnpm test:e2e` (needs the API running).
- API: `make api-install`, `make api-dev`, `make api-lint`, `make api-typecheck`, `make api-test` (Docker or `TEST_DATABASE_URL`), `make api-openapi` (after changing API schemas).
- Migrations: **Alembic only** (`pnpm db:migrate` / `make api-migrate` on empty DBs). Existing Drizzle-built DBs are **stamped** at `0001` (`docs/runbooks/alembic-cutover.md`). Question bank: `pnpm db:seed`. Evals: `pnpm eval` (Python, `services/api/evals`; paid).

## Architecture
- `apps/web` = UI only. Its only server code is Auth.js, `/api/token`, the internal user-upsert call and server components reading from the API with a minted token. No DB access, no LLM calls, no secrets beyond public env, the JWT signing key and the service credential.
- `services/api` = all business logic, data, AI, RAG and voice tooling. The browser calls it directly (`apps/web/src/lib/api-browser.ts`, typed by `packages/api-client`).
- Layering: api → services → repositories → models. Routers never query the DB. Repositories never call LLMs.
- The interview state machine is the source of truth for progress, never the LLM or the voice session. Each state has an explicit tool allowlist *(target: today every state offers the same six tools)*.
- Migrations: **Alembic only** (`services/api/alembic`). Never edit an applied migration. Schema changes are expand/contract until the old web version is gone from production (M5): the contract step (e.g. dropping the `embedding_model` defaults) waits for that.
- No new framework, service or dependency without an ADR in `docs/adr/`.

## Security (non-negotiable)
- API auth (ADR 0004): EdDSA JWT from `/api/token`, iss=vox-web, aud=vox-api, sub=user uuid, jti, exp ≤ 5 min. The API verifies with the public key only; every route except health uses `CurrentUser`. The private key never leaves the web env.
- Every user-scoped query filters by user_id in the repository. Every id route verifies ownership; not owned → 404.
- Voice tool calls are keyed by a server-issued voice session (`voice_sessions`) bound to the signed-in user and interview, never trusted from the client, and idempotent per `call_id`.
- Ephemeral Live tokens lock the model, system instruction and tools server-side *(target: needs a paid live session to verify, docs/verification.md Q2)*.
- Résumés, JDs, memories, retrieved chunks, model output and client-reported usage are untrusted input.
- Never log transcripts, résumé text, tokens or keys. Sentry and Langfuse get ids and metrics only.
- Every paid model path (chat, live voice, embeddings, evals) records token usage against the cost guard.
- Secrets only via environment. Never commit `.env*` files except `.env.example`. Production DB credentials live in `apps/web/.env.neon.local`, which nothing loads automatically.

## AI / RAG
- Prompts live in versioned files (`services/api/src/vox_api/prompts`); prompt_version is stored on the interview and on every trace *(target)*.
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
- Integration tests (services/api) use a real Postgres + pgvector (CI service or a local container), never staging or production. Tests refuse any DB except `TEST_DATABASE_URL`. Web tests are unit tests with the API mocked; E2E runs the real API.

## Workflow
- Inspect the code before changing it. Never assume reported behaviour exists; reproduce it first.
- Small commits, Conventional Commits. Use `git mv` for moves.
- Dev loop: run only the tests you are touching (`uv run --directory services/api pytest tests/test_x.py::test_y`, `pnpm --filter @vox/web exec vitest run tests/x.test.ts`, `pnpm --filter @vox/web exec playwright test e2e/x.spec.ts`), or the shortcuts `make test-api-fast`, `make test-web-fast`, `make e2e-smoke`. Run the full suites once before opening a PR, not after every step.
- Before reporting done: run lint, typecheck, tests and build; paste the real output. Mark each item VERIFIED / PARTIAL / FAILED / NOT TESTED.
- CI is split by side (`docs/ci-performance.md`): `api.yml` for services/api, `web.yml` for apps/web and packages, `e2e.yml` for either. A docs-only change runs none of them.
- Never push to `main`, deploy, run migrations on a real database, or change secrets or hosting settings without explicit approval. Work on a branch and open a PR.
- Update `docs/` when behaviour or architecture changes.

## Windows notes (this repo is developed on Windows)
- Vitest fails with "failed to find the runner" if the terminal's cwd uses a lowercase drive letter (`c:\…`). Open VS Code from `C:\…`.
- `make` isn't installed by default; every Makefile target is a single `pnpm …` or `uv …` command you can run directly.
