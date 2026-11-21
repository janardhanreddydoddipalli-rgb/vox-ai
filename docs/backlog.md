# Backlog

Agreed work that's deliberately scheduled later. Each item becomes its own branch and PR.

## After M1

- **Upgrade to Next 16.** This fixes the bundled `postcss` advisory (`next@15.5.29` bundles `postcss@8.4.31`; `npm audit` reports it as high). It isn't reachable in production, because PostCSS only runs at build time on our own CSS. Also align `eslint-config-next` (currently 16.x) with `next`. Do it as a separate PR with a full regression pass (lint, typecheck, unit, E2E smoke, build, and a manual voice check).
- **`drizzle-kit` advisories** (`esbuild` dev-server issue via `@esbuild-kit/*`): dev-only and never in production. They go away when Drizzle is removed in M4. Don't take `npm audit fix --force`, which would *downgrade* drizzle-kit to 0.18.

- **Align Postgres versions.** CI (`ci.yml`, `evals.yml`) and `compose.yaml` use `pgvector/pgvector:pg16`, but production Neon runs **Postgres 18.7** (pgvector 0.8.7). Move both to a pg18 image in one PR and confirm migrations and tests pass, so CI tests what production runs.

## M3

- Server-side `voice_sessions` table: tool calls keyed by a server-issued `voice_session_id`, idempotent per `call_id`, and a duration-based usage floor (see `docs/verification.md` Q1 and Q2).
- Rebuild email magic-link sign-in in FastAPI (ADR 0002 follow-up).
