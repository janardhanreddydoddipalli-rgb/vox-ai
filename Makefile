# Vox task runner. Every target is one command, so on machines without
# `make` (Windows without Git Bash tools) run the command under each target directly.
.PHONY: help install dev dev-web build lint typecheck test test-e2e migrate db-up db-down check \n	api-install api-dev api-lint api-typecheck api-test api-migrate api-seed api-eval api-up api-openapi

help:  ## List targets
	@grep -E "^[a-z-]+:.*## " Makefile | sed -E "s/:.*## /\t/"

install:  ## Install all JS workspace dependencies (exact lockfile versions)
	pnpm install --frozen-lockfile

api-install:  ## Install the API's Python 3.12 environment (exact uv.lock)
	uv sync --directory services/api --frozen

dev:  ## Web (http://localhost:3000) + API (http://localhost:8000) with hot reload
	$(MAKE) -j2 dev-web api-dev

dev-web:  ## Web app only, hot reload
	pnpm dev

build:  ## Production build of the web app
	pnpm build

lint:  ## ESLint
	pnpm lint

typecheck:  ## TypeScript (tsc --noEmit)
	pnpm typecheck

test:  ## Web unit tests (no database; API calls mocked)
	pnpm test

test-e2e:  ## Playwright smoke E2E against a running API, no model calls (needs DATABASE_URL)
	pnpm test:e2e

migrate:  ## Alembic upgrade head on DATABASE_URL (pgvector + every revision)
	pnpm db:migrate

db-up:  ## Start local Postgres (pgvector) + Redis from compose.yaml
	docker compose up -d --wait

db-down:  ## Stop local Postgres + Redis (data volume is kept)
	docker compose down

check:  ## lint + typecheck + test + build (what CI runs before E2E)
	pnpm lint && pnpm typecheck && pnpm test && pnpm build

api-dev:  ## API with hot reload on http://localhost:8000 (reads services/api/.env)
	uv run --directory services/api uvicorn vox_api.main:create_app --factory --reload --port 8000

api-lint:  ## Ruff lint + format check
	uv run --directory services/api ruff check . && uv run --directory services/api ruff format --check .

api-typecheck:  ## mypy --strict
	uv run --directory services/api mypy

api-test:  ## Pytest (TEST_DATABASE_URL, or a throwaway Postgres 18 via Docker)
	uv run --directory services/api pytest

api-migrate:  ## Alembic upgrade head on DATABASE_URL (existing Drizzle DBs: stamp, see runbook)
	uv run --directory services/api alembic upgrade head

api-seed:  ## Seed the question bank into DATABASE_URL (idempotent)
	uv run --directory services/api python scripts/seed_questions.py

api-eval:  ## Real-model evals on TEST_DATABASE_URL (paid: needs GEMINI_API_KEY)
	uv run --directory services/api python -m evals.run

api-up:  ## Build + start the API container with Postgres (compose profile "api")
	docker compose --profile api up -d --build --wait

api-openapi:  ## Export the API schema and regenerate the TypeScript client
	uv run --directory services/api python scripts/export_openapi.py && pnpm --filter @vox/api-client generate
