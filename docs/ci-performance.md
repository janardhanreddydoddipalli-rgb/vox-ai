# CI performance

Wall-clock seconds from `gh run view --json jobs`: each job from start to completion, and each workflow from its first job's start to its last job's end. Workflows run in parallel, so a PR waits for the slowest workflow it triggers.

## Before (main, last 3 runs, 2026-11-22)

One `ci.yml` job (web + build + E2E) and `api.yml` (one test job + Docker) ran on every relevant PR.

| Workflow / job | `1327cf3` | `8b71331` | `3a31e99` / `92d5f7a` |
|---|---|---|---|
| CI › ci (whole workflow) | 152 (total 155) | 175 (total 177) | 222 (total 225) |
| API › api | 45 | 48 | 47 |
| API › docker | 24 | 22 | 25 |
| API (whole workflow) | 47 | 51 | 50 |

Largest steps in CI › ci: Build 31–42, E2E 34–46 per run (two runs before #23), Install Playwright browser 13–18, unit tests 25–33 (with a database, before #23), Initialize containers 12–13, Install 4–8.
Largest steps in API › api: Initialize containers 12–16, Pytest 12–14, Mypy 6–8. API › docker: Build 16–18.

A PR touching one side waited for the slower of CI (155–225 s) and API (47–51 s).

## After (PR #24, 2026-11-22)

`web.yml`, `api.yml` and `e2e.yml`, each path-filtered with parallel jobs (ADR 0006). The first run had cold caches; the re-run had warm ones.

| Workflow / job | Cold | Warm | Main steps (warm) |
|---|---|---|---|
| Web › lint | 19 | 13 | install 4 |
| Web › typecheck (+ client drift) | 21 | 22 | install 5, tsc 5 |
| Web › unit | 18 | 18 | install 4 |
| **Web (workflow)** | **21** | **22** | |
| API › lint | 8 | 6 | |
| API › typecheck | 14 | 18 | mypy 8 |
| API › test (`pytest -n auto` + OpenAPI + Alembic check) | 39 | 39 | containers 14, pytest 9 (was 12–14 serial) |
| API › docker (buildx, GHA layer cache) | 46 | 34 | build 31 cold, 13 warm |
| **API (workflow)** | **46** | **40** | |
| E2E › e2e (build + Playwright) | 99 | 114 | containers 17, uv setup 18, build 22, Playwright deps 13 (browser from cache), E2E 7 (was 34–46) |
| **E2E (workflow)** | **99** | **114** | |

| What a PR changes | Before | After |
|---|---|---|
| Web only | 155–225 (CI) | ~100–115 (Web 22 ‖ E2E 99–114) |
| API only | 155–225 (CI ‖ API 47–51) | ~100–115 (API 40–46 ‖ E2E 99–114); Docker only when the image inputs change |
| Both | 155–225 | 99–114 (this PR) |
| Docs only | 155–225 (CI ran on every PR) | 0 (no workflow) |

E2E is now the critical path. Its biggest remaining costs are runner setup (service container, uv and Node setup) and the Next build, not the tests. Locally, E2E against one production build with 2 workers takes 15 s instead of about 1.3 min on the dev server. The local API suite is disk-bound on Docker Desktop for Windows (serial 50 s, `-n 2`/`4`/`auto` 59–67 s), so the dev loop there stays serial and targeted (`make test-api-fast`).
