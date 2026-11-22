# ADR 0006: Faster CI with parallel jobs, caches and pytest-xdist

- Status: Accepted (2026-11-22)

## Context

One `ci.yml` job ran everything for every PR in sequence (lint, typecheck, client drift, migrate, unit tests, build, Playwright install, E2E), and `api.yml` ran lint, types and tests in one job, plus a Docker build on every API change. Numbers are in `docs/ci-performance.md`.

## Decision

- **Split by side, filter by path.** `api.yml` (services/api, packages/api-client, its Dockerfile), `web.yml` (apps/web, packages, the root manifests) and `e2e.yml` (either side). A docs-only change runs none.
- **Parallel jobs.** Lint, typecheck and unit tests are separate jobs in each workflow. The web build runs only in the E2E job, which serves that one build with `next start` to 2 Playwright workers (chromium only).
- **Caches.** uv (setup-uv), the pnpm store (setup-node), `.next/cache`, Playwright browsers keyed by Playwright version, and Docker layers through buildx with the GitHub Actions cache (`docker/setup-buildx-action`, `docker/build-push-action`, the official Docker actions).
- **Docker image** only on `main` and on PRs that change services/api or its Dockerfile.
- **`concurrency`** per workflow and branch. A new push cancels the branch's run still in progress, except on `main`, where every merge gets its full run.
- **pytest-xdist** (new dev dependency) for `pytest -n auto` in CI. The suite migrates the `TEST_DATABASE_URL` database once and gives each worker its own copy (`CREATE DATABASE … TEMPLATE`, serialised by an advisory lock), so tests stay isolated.

## Consequences

- No test is removed or skipped: the same suites run, split across jobs.
- On this Windows machine (Postgres in Docker Desktop) the API suite is disk-bound and xdist is slower than serial, so the local default stays serial and the dev loop runs targeted tests (`CLAUDE.md` → Workflow).
- Path filters mean a docs-only PR runs no workflow. That is fine without branch protection; with required checks it would block (see `docs/ci-performance.md`).
