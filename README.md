# Vox: AI mock-interview voice assistant

Vox runs a spoken technical interview: it asks role-specific questions out loud, listens to your answers, asks follow-ups, scores each answer, and gives you a written report (also as a PDF). Interviews work in **English, Hindi (हिन्दी), Tamil (தமிழ்) and Telugu (తెలుగు)**, and Vox remembers your weak areas between interviews so it can drill them.

**Status (M2):** a monorepo. The whole product runs in `apps/web` (Next.js). The FastAPI backend in `services/api` is up but serves no product routes yet (they move one at a time in M3). The database is Neon Postgres in Singapore; **nothing is deployed yet**. See [docs/architecture.md](docs/architecture.md).

## How it works

| Part | What it does |
|---|---|
| **Voice** | Picks the best available path automatically: **Gemini Live** (full-duplex audio over WebSocket, short-lived token from `/api/voice/session`) → **browser speech** (Web Speech API) → **text**. Every path calls the same agent tools. |
| **Agent** | A bounded Gemini function-calling loop with tools to fetch questions, score answers (structured JSON), read your résumé and end the interview. |
| **Memory / RAG** | Your weaknesses, strengths and documents (résumé, job description) are embedded (`gemini-embedding-001`, 768 dims, pgvector) and recalled in later interviews. |
| **Safety & cost** | Google sign-in only; every query is scoped to your user; per-route rate limits; a per-user daily token budget covering text and live voice. |
| **Observability** | Sentry (user id only, never transcripts) and Langfuse traces (tokens, latency, cost). |

## Repository layout

```
apps/web/            Next.js app: src/ (app, agent, lib, voice), tests/, e2e/, evals/, scripts/, drizzle/ (frozen)
services/api/        FastAPI service (Python 3.12, uv): src/vox_api, alembic/, tests/
packages/api-client/ typed TypeScript client generated from the API's OpenAPI schema
docs/                architecture, ADRs, security, metrics, verification, backlog
.github/             CI (ci.yml), manual real-model evals (evals.yml), dependabot
compose.yaml         local Postgres (pgvector) + Redis
Makefile             one pnpm command per target
CLAUDE.md            engineering rules for humans and AI agents
```

## Quick start (local development)

**You need:** Node.js 22.12+ (CI uses 24), pnpm (run `corepack enable` once and the version pinned in `package.json` is used), [uv](https://docs.astral.sh/uv/) for the API (it installs Python 3.12 itself), Docker Desktop, and a [Gemini API key](https://aistudio.google.com/apikey).

```bash
pnpm install --frozen-lockfile        # make install
docker compose up -d --wait           # make db-up: Postgres (pgvector) + Redis
```

Create `apps/web/.env.local` (git-ignored) with at least:

```bash
DATABASE_URL=postgres://ubuntu:ubuntu@localhost:5432/voicebot
TEST_DATABASE_URL=postgres://ubuntu:ubuntu@localhost:5432/voicebot_test
AUTH_SECRET=any-long-random-string
E2E_TEST_AUTH=1                       # local only: adds a "Test sign-in" button
GEMINI_API_KEY=your-key
```

Then:

```bash
cd apps/web
node --env-file=.env.local scripts/migrate.mjs                # creates pgvector + applies migrations
pnpm exec tsx --env-file=.env.local scripts/seed-questions.ts # loads the 40-question bank
cd ../..
pnpm dev                                                      # http://localhost:3000
```

### API (optional in M2)

```bash
make api-install                                  # uv sync --directory services/api --frozen
node apps/web/scripts/generate-api-jwt-keys.mjs   # private key -> apps/web/.env.local, public key -> services/api/.env
cp services/api/.env.example services/api/.env   # fill JWT_PUBLIC_KEY + INTERNAL_API_TOKEN (same token in apps/web/.env.local)
make api-dev                                      # http://localhost:8000/docs
```

If port 5432 is already used by another Postgres, start compose with `POSTGRES_PORT=5434 docker compose up -d --wait` and use port 5434 in the URLs.

## Commands

Run these from the repo root (each delegates to `@vox/web`). Without `make`, use the pnpm form.

| make | pnpm | What |
|---|---|---|
| `make dev` | `pnpm dev` | Dev server with hot reload |
| `make lint` | `pnpm lint` | ESLint |
| `make typecheck` | `pnpm typecheck` | `tsc --noEmit` |
| `make test` | `pnpm test` | Unit + API tests against `TEST_DATABASE_URL` (real Postgres; mocked Gemini) |
| `make test-e2e` | `pnpm test:e2e` | Playwright smoke tests, no model calls (needs `DATABASE_URL`) |
| `make build` | `pnpm build` | Production build |
| `make migrate` | `pnpm db:migrate` | Alembic upgrade head on `DATABASE_URL` (needs `uv`; empty or Alembic-managed DBs only) |
| `make check` | | lint + typecheck + test + build |
| `make api-lint` / `make api-typecheck` | `uv run --directory services/api ruff check .` / `uv run --directory services/api mypy` | API lint, format check, strict types |
| `make api-test` | `uv run --directory services/api pytest` | API tests on Postgres 18 + pgvector (Docker, or `TEST_DATABASE_URL`) |
| `make api-migrate` | `uv run --directory services/api alembic upgrade head` | Alembic on `DATABASE_URL` (**empty DBs only**; existing ones are stamped, see the runbook) |
| `make api-openapi` | | Re-export the API schema and regenerate `@vox/api-client` |
| `make dev` | | Web + API together with hot reload |

Real-model checks (the 20-case eval and the full interview E2E test) cost money, so they run only from **Actions → "Evals (manual, real model)"**, never on push.

## Environment variables

Local: `apps/web/.env.local` (git-ignored). Production: Vercel → Settings → Environment Variables. **Never commit real values.** `apps/web/.env.example` lists every name with placeholders.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection. App on Vercel: Neon **pooled** URL. Migrations: Neon **direct** URL. |
| `TEST_DATABASE_URL` | tests | Dedicated test database. Tests refuse to run against anything else. |
| `AUTH_SECRET` | yes | Auth.js secret (`openssl rand -base64 32`), different per environment |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes (prod) | Google OAuth, the only sign-in method ([ADR 0002](docs/adr/0002-google-only-auth.md)) |
| `AUTH_TRUST_HOST` | `next start` outside Vercel | `true` when running a production build yourself; Vercel sets it automatically |
| `GEMINI_API_KEY` | yes | Gemini API. **Use a billing-enabled project in production**: the free tier allows 20 text requests a day. |
| `GEMINI_MODEL` | no | Text model (default `gemini-3.5-flash`) |
| `GEMINI_LIVE_MODEL` | no | Live voice model (default `models/gemini-3.1-flash-live-preview`) |
| `GEMINI_EMBEDDING_MODEL` | no | Embedding model (default `gemini-embedding-001`) |
| `CHAT_CONTEXT_TURNS` | no | Past turns sent as context (default 8) |
| `DAILY_TOKEN_BUDGET` | prod | Per-user daily token budget (default 200000; `0` disables) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | prod | Shared rate limiting. Without them each server instance limits on its own (and logs a warning). |
| `NEXT_PUBLIC_SITE_URL` | prod | Public origin for metadata, sitemap and robots |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE` | no | Server error monitoring (inactive without a DSN) |
| `NEXT_PUBLIC_SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_SENTRY_RELEASE` | no | Browser error monitoring |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | no | Source-map upload at build time |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` | no | Agent-turn tracing |
| `LANGFUSE_GEMINI_INPUT_PRICE_PER_1M`, `LANGFUSE_GEMINI_OUTPUT_PRICE_PER_1M` | no | Override the cost estimate in traces |
| `API_JWT_PRIVATE_KEY` | when calling the API | Ed25519 private key that signs `/api/token` JWTs. Web only, secret ([ADR 0004](docs/adr/0004-api-auth-eddsa-jwt.md)). |
| `API_INTERNAL_URL` / `INTERNAL_API_TOKEN` | with `AUTH_UPSERT_VIA_API` | API base URL and the shared service credential (32+ chars, same value in the API) |
| `AUTH_UPSERT_VIA_API` | no | `1` = resolve the user id through the API at sign-in (default off) |
| `E2E_TEST_AUTH` | tests only | `1` adds a password-less test sign-in. **Never set it in production.** |
| `EVAL_PASS_THRESHOLD` | evals | Eval pass-rate gate (default 0.9) |

## Database

- **Schema:** `apps/web/src/lib/db/schema.ts` (Drizzle). All access goes through `src/lib/db/repository.ts`, which scopes every user query.
- **Migrations: Alembic** (`services/api/alembic`). Baseline `0001` reproduces the frozen Drizzle schema exactly and creates pgvector. New, empty databases: `make api-migrate`. Existing Drizzle-built databases (Neon production): **`alembic stamp 0001`, never upgrade**. See [docs/runbooks/alembic-cutover.md](docs/runbooks/alembic-cutover.md).
- `apps/web/drizzle` (0000–0008) is **frozen** and no longer applied anywhere: `pnpm db:migrate`, the web tests and the evals run Alembic. A local database built by Drizzle earlier must be recreated or stamped (runbook).
- **Production (Neon, Singapore):** keep the **direct** connection string in `apps/web/.env.neon.local` (git-ignored, never loaded automatically). The API's own env lives in `services/api/.env` (`services/api/.env.example`).

## Windows notes

- **Vitest "failed to find the runner":** happens when the terminal's working directory has a lowercase drive letter (`c:\…`, common in VS Code). Open VS Code from `C:\…`, or run tests from a terminal started in `C:\…`.
- **`make`:** not installed by default (`scoop install make` or `choco install make`), but every target is a single pnpm command you can run directly.
- **Line endings:** `.gitattributes` keeps the `Makefile` and shell scripts LF.

## Pre-commit hooks (recommended)

```bash
pipx install pre-commit   # or: pip install pre-commit
pre-commit install        # once per clone: gitleaks, large files, merge markers, yaml/json, eslint
```

## Further reading

- [docs/architecture.md](docs/architecture.md): current and target architecture, migration path
- [docs/adr/](docs/adr/): decisions (0001 monorepo, 0002 Google-only, 0003 FastAPI, 0004 EdDSA tokens, 0005 hosting)
- [docs/runbooks/alembic-cutover.md](docs/runbooks/alembic-cutover.md): Drizzle to Alembic handover
- [docs/security.md](docs/security.md): threat model, controls, findings
- [docs/verification.md](docs/verification.md): what is verified, open questions
- [docs/metrics.md](docs/metrics.md): latency method (baseline deferred)
- [docs/backlog.md](docs/backlog.md): scheduled follow-ups
- [docs/device-testing.md](docs/device-testing.md): Phase 6 device and browser results
- [CLAUDE.md](CLAUDE.md): engineering rules
