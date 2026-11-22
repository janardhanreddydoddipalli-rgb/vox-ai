# Security

Rules live in `CLAUDE.md`. This page records the threat model, the controls as they work **today**, and the history of findings.

## Assets and threats

| Asset | Main threats |
|---|---|
| Candidates' résumés, answers, transcripts, memories | Cross-user access (IDOR), leakage into logs or telemetry |
| Gemini spend | Abuse of paid paths (chat, live voice, embeddings), forged usage |
| Interview integrity (scores, reports) | Tool calls forged from the browser, prompt injection through résumé/JD text |
| Credentials (Gemini key, DB URL, Auth secret) | Committed to git, pasted into tools or chat |

## Controls in place (M4)

### Web app (`apps/web`: UI, sign-in, tokens)

| Control | Where | Test |
|---|---|---|
| No database, model key or rate-limit credentials in the web app | removed in M4 (#23); its only server code is Auth.js, `/api/token`, the upsert call and server pages reading the API | `pnpm build` route list: `/api/auth/*`, `/api/token` only |
| Signed-out visits and `/api/token` calls are refused | `src/middleware.ts`, `src/app/api/token/route.ts` | `tests/middleware.test.ts`, `tests/api-token.test.ts` |
| API tokens: EdDSA, 5 min, `sub` = `users.id` resolved at sign-in (never the OAuth id), private key in the web env only | `src/lib/api-token.ts`, `src/lib/auth.ts` | `tests/api-token.test.ts`, `tests/auth-callbacks.test.ts` |
| The browser keeps the token in memory only, never in storage | `src/lib/api-browser.ts` | `tests/api-browser.test.ts` |
| Deleting the account also ends the session | `src/app/dashboard/dashboard-client.tsx` | E2E `interview-lifecycle.spec.ts` |
| Secrets outside git | `.gitignore` (`.env`, `.env*.local`), gitleaks pre-commit hook | `gitleaks` scan (see below) |
| Supply chain | pnpm blocks dependency install scripts unless listed in `allowBuilds`; Dependabot | — |

### API (`services/api`)

| Control | Where | Test |
|---|---|---|
| EdDSA-only JWT verification (public key only; iss, aud, exp, iat, sub=uuid, jti required; 30 s leeway) | `core/security.py`, `api/deps.py` | `tests/test_auth.py` (expired, wrong aud/iss, tampered, other key, HS256 alg confusion, missing claims, non-uuid sub, deleted user) |
| Every user-scoped query filters by user id; not owned → 404 | `repositories/*` | `tests/security/test_cross_user.py` |
| Any `{id}` route must have a cross-user (404) test | `tests/security/test_route_ownership.py` | runs in CI (fails on an unregistered route) |
| Agent tools get the ownership-checked interview object, never an id to look up; each tool runs in a savepoint | `agent/tools/base.py`, `agent/loop.py` | `tests/test_agent.py` |
| Voice tool calls and usage are keyed by a server-issued voice session bound to the user and interview, idempotent per `call_id`; usage reports are bounded | `api/v1/voice.py`, `services/voice.py` | `tests/test_voice.py`, cross-user voice tests |
| Rate limits per route and user (Upstash in production, in-memory otherwise) | `core/rate_limit.py`, `api/deps.py` | `tests/test_rate_limit.py`, per-route tests |
| Daily token budget on every paid path (chat, tools, embeddings, reports, live voice, evals) | `services/cost_guard.py` | budget tests in `test_agent.py`, `test_voice.py` |
| Retrieval reads only the user's rows and compares only same-model vectors; retrieved text is labelled data | `rag/retrieve.py`, `agent/tools/*` | `tests/test_rag.py` |
| Service credential for `/internal/*`, constant-time compare, hidden from OpenAPI | `api/deps.py`, `main.py` | `tests/test_internal_users.py` |
| Every error is problem+json; validation errors never echo input | `core/errors.py` | `tests/test_health_and_errors.py` |
| CORS: only `WEB_ORIGIN`, no credentials | `main.py` | `test_cors_allows_only_the_web_origin` |
| Logs: JSON, request_id, never bodies or transcripts; Sentry user id only, bodies/cookies/auth headers scrubbed | `core/logging.py`, `core/middleware.py`, `observability/sentry.py` | (reviewed) |
| No docs or schema in production | `main.py` | `test_docs_and_schema_are_hidden_in_production` |
| Container runs as non-root uid 10001 | `infra/docker/api.Dockerfile` | `api.yml` docker smoke |

## Known gaps (tracked)

- **Live voice trusts the browser for usage numbers and the setup frame.** Tool calls and usage are keyed by a server-issued voice session (it fixes the user and interview) and are idempotent per `call_id`. Still open: ephemeral tokens with locked config (Q2) and a duration-based usage floor (Q1). Both need a paid live session (`docs/verification.md`).
- **Prompt injection through résumé/JD text:** mitigated by the explicit tool registry, schema-validated tool input, ownership-bound tools and retrieved text labelled as data. A per-state tool allowlist is still a target.
- **`npm audit`/`pnpm audit`:** a postcss advisory inside Next (build-time only, not reachable at runtime). The drizzle-kit/esbuild advisories went with Drizzle in M4. See `docs/backlog.md`.
- **`/api/token` has no rate limit of its own** since M4 (the web app holds no Upstash credentials). It needs a session and only signs a JWT; every API route the token reaches is rate-limited per user.

## Findings history

| Date | Finding | Severity | Fix |
|---|---|---|---|
| 2026-11-21 | `/api/voice/tool` trusted the client's `interviewId`: another user's résumé could be read, and their interview written to or completed | High | `1694ec7` |
| 2026-11-21 | Upstash limiter never wired up: production would have had per-instance limits only | Medium | `db906f6` |
| 2026-11-21 | Live voice usage never recorded: unlimited spend per session | Medium | `55ff4a3` |
| 2026-11-21 | User speech written to server logs | Medium | `e9b103e` |
| 2026-11-21 | Free-text language field placed into the system prompt | Low | `e9b103e` |
| 2026-11-21 | Gemini key and Neon password pasted into a chat session | High (credential exposure) | Neon project recreated with a new password. **The Gemini key must still be rotated.** |
| 2026-11-22 | Playground history: a user could append turns to another user's session id and read them back | High | #14 |
| 2026-11-22 | Live voice sessions declared no agent tools; then sent them in the wrong setup shape (bare declarations) | Medium (broken voice tools) | `b11eef1`, #18 |

## Secret scanning

The gitleaks pre-commit hook scans staged changes. To scan the full history: `docker run --rm -v "${PWD}:/repo" zricethezav/gitleaks:latest git /repo`.
