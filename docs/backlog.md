# Backlog

Agreed work that's deliberately scheduled later. Each item becomes its own branch and PR.

## After M1

- **Upgrade to Next 16.** This fixes the bundled `postcss` advisory (`next@15.5.29` bundles `postcss@8.4.31`; `npm audit` reports it as high). It isn't reachable in production, because PostCSS only runs at build time on our own CSS. Also align `eslint-config-next` (currently 16.x) with `next`. Do it as a separate PR with a full regression pass (lint, typecheck, unit, E2E smoke, build, and a manual voice check).
- **`drizzle-kit` advisories** (`esbuild` dev-server issue via `@esbuild-kit/*`): dev-only and never in production. They go away when Drizzle is removed in M4. Don't take `npm audit fix --force`, which would *downgrade* drizzle-kit to 0.18.

- **Terms page (Phase 13, launch).** The footer link to `/terms` was removed because the page didn't exist (decision 2026-11-22). Add a Terms of Service page and restore the link at launch; `tests/internal-links.test.ts` will fail if the link returns before the page does.

- **Playground text mode.** When the mic or speech engine fails with a generic error, the playground shows "Could not start" instead of falling back to text mode (only `NotAllowedError`/`NotFoundError` trigger it), so browsers without speech support can't chat there.

## M3

- Server-side `voice_sessions` table: tool calls keyed by a server-issued `voice_session_id`, idempotent per `call_id`, and a duration-based usage floor (see `docs/verification.md` Q1 and Q2).
- Rebuild email magic-link sign-in in FastAPI (ADR 0002 follow-up).
