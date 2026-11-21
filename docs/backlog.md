# Backlog

Agreed work that's deliberately scheduled later. Each item becomes its own branch and PR.

## After M1

- **Upgrade to Next 16.** This fixes the bundled `postcss` advisory (`next@15.5.29` bundles `postcss@8.4.31`; `npm audit` reports it as high). It isn't reachable in production, because PostCSS only runs at build time on our own CSS. Also align `eslint-config-next` (currently 16.x) with `next`. Do it as a separate PR with a full regression pass (lint, typecheck, unit, E2E smoke, build, and a manual voice check).
- **`drizzle-kit` advisories** (`esbuild` dev-server issue via `@esbuild-kit/*`): dev-only and never in production. They go away when Drizzle is removed in M4. Don't take `npm audit fix --force`, which would *downgrade* drizzle-kit to 0.18.

- **Terms page.** The landing-page footer links to `/terms`, which doesn't exist (404). Write a Terms of Service page or remove the link. Legal text is a product decision, so it wasn't invented in M1. (`/terms` was removed from the sitemap in M1.)

- **Web: `upsertUserByEmail` blanks names.** On conflict it sets `name`/`image` to the passed values, and most callers pass only the email, so the stored name and image become NULL on every such request. Fix: keep stored values when none are passed (as `services/api` does), or retire it in M3 when user writes move to the API.

## M3

- Server-side `voice_sessions` table: tool calls keyed by a server-issued `voice_session_id`, idempotent per `call_id`, and a duration-based usage floor (see `docs/verification.md` Q1 and Q2).
- Rebuild email magic-link sign-in in FastAPI (ADR 0002 follow-up).
