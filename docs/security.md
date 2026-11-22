# Security

Rules live in `CLAUDE.md`. This page records the threat model, the controls as they work **today**, and the history of findings.

## Assets and threats

| Asset | Main threats |
|---|---|
| Candidates' résumés, answers, transcripts, memories | Cross-user access (IDOR), leakage into logs or telemetry |
| Gemini spend | Abuse of paid paths (chat, live voice, embeddings), forged usage |
| Interview integrity (scores, reports) | Tool calls forged from the browser, prompt injection through résumé/JD text |
| Credentials (Gemini key, DB URL, Auth secret) | Committed to git, pasted into tools or chat |

## Controls in place (M1)

Paths are relative to `apps/web`.

| Control | Where | Test |
|---|---|---|
| Auth on every API route except health/auth | `src/middleware.ts` + per-route checks | `tests/api-*.test.ts` (401 cases) |
| Ownership: not owned → 404 | Repository functions take `userId`; `/api/voice/tool` and `/api/voice/usage` check the interview before acting | `tests/api-voice-tool.test.ts`, `tests/api-voice-usage.test.ts` |
| Tools double-check ownership | `ownedInterview()` in `src/agent/tools/interview-tools.ts`; scoring refuses before the paid model call | Handler-level test in `api-voice-tool.test.ts` |
| Rate limits per route and user | `src/lib/rate-limit.ts` (Upstash in production; allows requests if Upstash is down) | `tests/rate-limit.test.ts`, `tests/voice-rate-limit.test.ts` |
| Daily token budget | `src/lib/cost-guard.ts`; text and live usage both recorded | `tests/api-voice-usage.test.ts` |
| Input validation | zod at every route; the live-session language must be a supported code | `tests/voice-session-language.test.ts` |
| No transcript text in logs | ids and lengths only; Sentry `beforeSend` scrubs request bodies | `tests/chat-logging.test.ts` |
| Same-origin check on POSTs | `originAllowed()` | `tests/api-turns.test.ts` |
| Secrets outside git | `.gitignore` (`.env`, `.env*.local`), gitleaks pre-commit hook | `gitleaks` scan (see below) |
| Supply chain | pnpm blocks dependency install scripts unless listed in `allowBuilds`; Dependabot | — |

## API controls (services/api, M2)

| Control | Where | Test |
|---|---|---|
| EdDSA-only JWT verification (public key only; iss, aud, exp, iat, sub=uuid, jti required; 30 s leeway) | `core/security.py`, `api/deps.py` | `tests/test_auth.py` (expired, wrong aud/iss, tampered, other key, HS256 alg confusion, missing claims, non-uuid sub, deleted user) |
| Service credential for `/internal/*`, constant-time compare, hidden from OpenAPI | `api/deps.py`, `main.py` | `tests/test_internal_users.py` |
| Every error is problem+json; validation errors never echo input | `core/errors.py` | `tests/test_health_and_errors.py` |
| CORS: only `WEB_ORIGIN`, no credentials | `main.py` | `test_cors_allows_only_the_web_origin` |
| Logs: JSON, request_id, never bodies; Sentry user id only, bodies/cookies/auth headers scrubbed | `core/logging.py`, `core/middleware.py`, `observability/sentry.py` | (reviewed) |
| No docs or schema in production | `main.py` | `test_docs_and_schema_are_hidden_in_production` |
| Container runs as non-root uid 10001 | `infra/docker/api.Dockerfile` | `api.yml` docker smoke |
| Any `{id}` route must have a cross-user (404) test | `tests/security/test_route_ownership.py` | runs in CI |

## Known gaps (tracked)

- **Live voice trusts the browser for usage numbers and the setup frame.** With `ROUTE_VOICE=fastapi`, tool calls and usage are keyed by a server-issued voice session (it fixes the user and interview) and are idempotent per `call_id`. Still open: ephemeral tokens with locked config (Q2) and a duration-based usage floor (Q1). Both need a paid live session (`docs/verification.md`).
- **Prompt injection through résumé/JD text:** mitigated only by the tool allowlist and schema-validated tool input. A per-state tool allowlist arrives with the M3 state machine.
- **`npm audit`/`pnpm audit`:** a postcss advisory inside Next (build-time only, not reachable at runtime) and dev-only drizzle-kit/esbuild advisories. See `docs/backlog.md`.

## Findings history

| Date | Finding | Severity | Fix |
|---|---|---|---|
| 2026-11-21 | `/api/voice/tool` trusted the client's `interviewId`: another user's résumé could be read, and their interview written to or completed | High | `1694ec7` |
| 2026-11-21 | Upstash limiter never wired up: production would have had per-instance limits only | Medium | `db906f6` |
| 2026-11-21 | Live voice usage never recorded: unlimited spend per session | Medium | `55ff4a3` |
| 2026-11-21 | User speech written to server logs | Medium | `e9b103e` |
| 2026-11-21 | Free-text language field placed into the system prompt | Low | `e9b103e` |
| 2026-11-21 | Gemini key and Neon password pasted into a chat session | High (credential exposure) | Neon project recreated with a new password. **The Gemini key must still be rotated.** |

## Secret scanning

The gitleaks pre-commit hook scans staged changes. To scan the full history: `docker run --rm -v "${PWD}:/repo" zricethezav/gitleaks:latest git /repo`.
