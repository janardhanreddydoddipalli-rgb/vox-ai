# Vox: AI mock-interview voice assistant

Vox runs a spoken technical interview: it asks role-specific questions out loud, listens to your answers, asks follow-ups, scores each answer, and gives you a written report (also as a PDF). Interviews work in **English, Hindi (हिन्दी), Tamil (தமிழ்) and Telugu (తెలుగు)**, and Vox remembers your weak areas between interviews so it can drill them.

**Status (M4):** a monorepo. `apps/web` (Next.js) is the UI: it renders pages, signs users in and mints short-lived API tokens. All data, AI, RAG and voice tooling live in `services/api` (FastAPI), which the browser calls directly. The database is Neon Postgres in Singapore; **nothing new is deployed yet** (M5). See [docs/architecture.md](docs/architecture.md).

## How it works

| Part | What it does |
|---|---|
| **Voice** | Picks the best available path automatically: **Gemini Live** (full-duplex audio over WebSocket, short-lived token and session from `POST /v1/voice/sessions`) → **browser speech** (Web Speech API) → **text**. Every path calls the same agent tools. |
| **Agent** | A bounded Gemini function-calling loop with tools to fetch questions, score answers (structured JSON), read your résumé, search your documents, recall memories and end the interview. |
| **Memory / RAG** | Your weaknesses, strengths and documents (résumé, job description) are embedded (`gemini-embedding-001`, 768 dims, pgvector) and recalled in later interviews; document search is hybrid (vector + full-text, RRF). |
| **Safety & cost** | Google sign-in only; 5-minute EdDSA tokens for the API; every query is scoped to your user; per-route rate limits; a per-user daily token budget covering text, embeddings and live voice. |
| **Observability** | Sentry (ids and metrics only, never transcripts); token usage per user per day. |

## Repository layout

```
apps/web/            Next.js UI: src/ (app, lib, voice), tests/ (unit), e2e/ (Playwright), scripts/
services/api/        FastAPI service (Python 3.12, uv): src/vox_api, alembic/, tests/, evals/, scripts/
packages/api-client/ typed TypeScript client generated from the API's OpenAPI schema
docs/                architecture, ADRs, security, metrics, verification, backlog, runbooks
.github/             CI (ci.yml, api.yml), manual real-model evals (evals.yml), dependabot
compose.yaml         local Postgres (pgvector) + Redis, and the API container (profile "api")
Makefile             one command per target
CLAUDE.md            engineering rules for humans and AI agents
```

## Quick start (local development)

**You need:** Node.js 22.12+ (CI uses 24), pnpm (run `corepack enable` once and the version pinned in `package.json` is used), [uv](https://docs.astral.sh/uv/) for the API (it installs Python 3.12 itself), Docker Desktop, and a [Gemini API key](https://aistudio.google.com/apikey).

```bash
pnpm install --frozen-lockfile        # make install
make api-install                      # uv sync --directory services/api --frozen
docker compose up -d --wait           # make db-up: Postgres (pgvector) + Redis
node apps/web/scripts/generate-api-jwt-keys.mjs   # private key -> apps/web/.env.local, public key -> services/api/.env
cp services/api/.env.example services/api/.env   # fill JWT_PUBLIC_KEY, INTERNAL_API_TOKEN, GEMINI_API_KEY
```

Create `apps/web/.env.local` (git-ignored) with at least:

```bash
AUTH_SECRET=any-long-random-string
E2E_TEST_AUTH=1                       # local only: adds a "Test sign-in" button
API_JWT_PRIVATE_KEY=...               # from generate-api-jwt-keys.mjs
API_INTERNAL_URL=http://localhost:8000
NEXT_PUBLIC_API_URL=http://localhost:8000
INTERNAL_API_TOKEN=...                # the same value as in services/api/.env
```

Then, from the repo root:

```bash
DATABASE_URL=postgres://ubuntu:ubuntu@localhost:5432/voicebot pnpm db:migrate   # Alembic: pgvector + every revision
DATABASE_URL=postgres://ubuntu:ubuntu@localhost:5432/voicebot pnpm db:seed      # the 40-question bank
make dev                                                                        # web :3000 + API :8000 (API docs at /docs)
```

If port 5432 is already used by another Postgres, start compose with `POSTGRES_PORT=5434 docker compose up -d --wait` and use port 5434 in the URLs.

## Commands

Run these from the repo root. Without `make`, use the pnpm or uv form.

| make | pnpm / uv | What |
|---|---|---|
| `make dev` | | Web + API together with hot reload |
| `make dev-web` | `pnpm dev` | Web app only |
| `make lint` | `pnpm lint` | ESLint |
| `make typecheck` | `pnpm typecheck` | `tsc --noEmit` |
| `make test` | `pnpm test` | Web unit tests (no database; API calls mocked) |
| `make test-e2e` | `pnpm test:e2e` | Playwright smoke tests against the web app and a running API, no model calls |
| `make build` | `pnpm build` | Production build |
| `make migrate` | `pnpm db:migrate` | Alembic upgrade head on `DATABASE_URL` (empty or Alembic-managed DBs only) |
| `make check` | | lint + typecheck + test + build |
| `make api-lint` / `make api-typecheck` | `uv run --directory services/api ruff check .` / `uv run --directory services/api mypy` | API lint, format check, strict types |
| `make api-test` | `uv run --directory services/api pytest` | API tests on Postgres 18 + pgvector (Docker, or `TEST_DATABASE_URL`) |
| `make api-migrate` | `uv run --directory services/api alembic upgrade head` | Alembic on `DATABASE_URL` (**empty DBs only**; existing ones are stamped, see the runbook) |
| `make api-seed` | `pnpm db:seed` | Seed the question bank (idempotent) |
| `make api-eval` | `pnpm eval` | The 20-case real-model eval (**paid**) |
| `make api-openapi` | | Re-export the API schema and regenerate `@vox/api-client` |

Real-model checks (the 20-case eval and the full interview E2E test) cost money, so in CI they run only from **Actions → "Evals (manual, real model)"**, never on push.

## Environment variables

**Never commit real values.** Each app has an `.env.example` listing every name with placeholders.

**Web** (`apps/web/.env.local`; production: Vercel → Settings → Environment Variables). The web app holds no database URL, model key or rate-limit credentials.

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | yes | Auth.js secret (`openssl rand -base64 32`), different per environment |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes (prod) | Google OAuth, the only sign-in method ([ADR 0002](docs/adr/0002-google-only-auth.md)) |
| `AUTH_TRUST_HOST` | `next start` outside Vercel | `true` when running a production build yourself; Vercel sets it automatically |
| `API_JWT_PRIVATE_KEY` | yes | Ed25519 private key that signs `/api/token` JWTs. Web only, secret ([ADR 0004](docs/adr/0004-api-auth-eddsa-jwt.md)). |
| `API_INTERNAL_URL` | yes | Where the web server reaches the API (server-rendered pages, the sign-in upsert) |
| `INTERNAL_API_TOKEN` | yes | Service credential for `/internal/users/upsert` (32+ chars, same value in the API) |
| `NEXT_PUBLIC_API_URL` | yes | Where the browser reaches the API (public; the API allows the web origin by CORS) |
| `NEXT_PUBLIC_SITE_URL` | prod | Public origin for metadata, sitemap and robots |
| `SENTRY_*`, `NEXT_PUBLIC_SENTRY_*` | no | Error monitoring and source-map upload (inactive without a DSN) |
| `E2E_TEST_AUTH` | tests only | `1` adds a password-less test sign-in. **Never set it in production.** |

**API** (`services/api/.env`, see `services/api/.env.example`): `DATABASE_URL`, `WEB_ORIGIN`, `JWT_PUBLIC_KEY`, `INTERNAL_API_TOKEN`, `GEMINI_API_KEY` (**billing-enabled project in production**: the free tier allows 20 text requests a day), optional `GEMINI_MODEL` / `GEMINI_LIVE_MODEL` / `GEMINI_EMBEDDING_MODEL`, `DAILY_TOKEN_BUDGET`, `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (shared rate limits in production), `SENTRY_DSN`. Evals also read `TEST_DATABASE_URL` and `EVAL_PASS_THRESHOLD`.

## Database

- **Schema and access:** `services/api` (SQLAlchemy models in `src/vox_api/models`, user-scoped queries in `src/vox_api/repositories`). The web app has no database access.
- **Migrations: Alembic** (`services/api/alembic`). Baseline `0001` reproduces the schema the old Drizzle migrations built and creates pgvector; later revisions are expand-only while both app versions can run. New, empty databases: `make api-migrate`. Existing Drizzle-built databases (Neon production): **`alembic stamp 0001`, then upgrade**. See [docs/runbooks/alembic-cutover.md](docs/runbooks/alembic-cutover.md).
- **Production (Neon, Singapore):** keep the **direct** connection string in `apps/web/.env.neon.local` (git-ignored, never loaded automatically). The API's own env lives in `services/api/.env`.

## Windows notes

- **Vitest "failed to find the runner":** happens when the terminal's working directory has a lowercase drive letter (`c:\…`, common in VS Code). Open VS Code from `C:\…`, or run tests from a terminal started in `C:\…`.
- **`make`:** not installed by default (`scoop install make` or `choco install make`), but every target is a single command you can run directly.
- **Line endings:** `.gitattributes` keeps the `Makefile` and shell scripts LF.

## Pre-commit hooks (recommended)

```bash
pipx install pre-commit   # or: pip install pre-commit
pre-commit install        # once per clone: gitleaks, large files, merge markers, yaml/json, eslint
```

## Further reading

- [docs/architecture.md](docs/architecture.md): architecture and migration path
- [docs/adr/](docs/adr/): decisions (0001 monorepo, 0002 Google-only, 0003 FastAPI, 0004 EdDSA tokens, 0005 hosting)
- [docs/runbooks/alembic-cutover.md](docs/runbooks/alembic-cutover.md): Drizzle to Alembic handover for existing databases
- [docs/security.md](docs/security.md): threat model, controls, findings
- [docs/verification.md](docs/verification.md): what is verified, open questions
- [docs/metrics.md](docs/metrics.md): latency method (baseline deferred)
- [docs/progress.md](docs/progress.md) and [docs/needs-human.md](docs/needs-human.md): migration status and what needs a person
- [docs/backlog.md](docs/backlog.md): scheduled follow-ups
