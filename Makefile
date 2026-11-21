# Vox task runner. Every target is one command, so on machines without
# `make` (Windows without Git Bash tools) run the command under each target directly.
.PHONY: help install dev build lint typecheck test test-e2e migrate db-up db-down check

help:  ## List targets
	@grep -E "^[a-z-]+:.*## " Makefile | sed -E "s/:.*## /\t/"

install:  ## Install all workspace dependencies (exact lockfile versions)
	pnpm install --frozen-lockfile

dev:  ## Run the web app with hot reload on http://localhost:3000
	pnpm dev

build:  ## Production build of the web app
	pnpm build

lint:  ## ESLint
	pnpm lint

typecheck:  ## TypeScript (tsc --noEmit)
	pnpm typecheck

test:  ## Unit + API tests (needs TEST_DATABASE_URL, see README)
	pnpm test

test-e2e:  ## Playwright smoke E2E, no model calls (needs DATABASE_URL)
	pnpm test:e2e

migrate:  ## Create pgvector + apply migrations to DATABASE_URL
	pnpm db:migrate

db-up:  ## Start local Postgres (pgvector) + Redis from compose.yaml
	docker compose up -d --wait

db-down:  ## Stop local Postgres + Redis (data volume is kept)
	docker compose down

check:  ## lint + typecheck + test + build (what CI runs before E2E)
	pnpm lint && pnpm typecheck && pnpm test && pnpm build
