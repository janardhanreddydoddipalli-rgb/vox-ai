# ADR 0002: Google-only sign-in

- Status: Accepted
- Date: 2026-11-21

## Context

Vox offered two sign-in methods: Google OAuth and email magic links through the Auth.js Resend provider.

Auth.js needs a database adapter for any email provider, to store verification tokens. The app runs Auth.js with `session: { strategy: "jwt" }` and no adapter. `@auth/drizzle-adapter` was installed but never wired up. Auth.js's config check (`@auth/core/lib/utils/assert.js`) rejects an email provider without an adapter (`MissingAdapter: Email login requires an adapter`). That check covers every auth request, so setting `RESEND_API_KEY` would also have broken Google sign-in.

The target architecture (ADR 0001, monorepo + FastAPI, written in M1) makes `apps/web` UI-only with no database access. Adding a Drizzle adapter would put a direct database connection back into the web app, against that rule.

## Decision

- Sign-in is **Google OAuth only**.
- Remove the Resend provider and the magic-link form. Remove the unused `@auth/drizzle-adapter` dependency.
- Keep the Playwright-only credentials provider (`E2E_TEST_AUTH=1`) for E2E tests. It is never enabled in production.

## Consequences

- Users without a Google account can't sign in. That's acceptable for now, since most of the target users have one.
- `RESEND_API_KEY` and `EMAIL_FROM` are no longer read. Remove them from the Vercel environment.
- **Follow-up:** rebuild magic links inside FastAPI after M3. FastAPI owns the database, so it can store verification tokens, send the email, and hand the verified identity to Auth.js or issue the session itself. That needs its own ADR.
