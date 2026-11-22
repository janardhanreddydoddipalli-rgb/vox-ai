# CI performance

Wall-clock seconds from `gh run view --json jobs` (job start → completion; steps under 1 s omitted). Measured with `C:\…\scratchpad\ci_times.py`-style parsing of the GitHub API timestamps.

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
