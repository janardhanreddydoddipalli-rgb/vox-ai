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

## Known gaps (tracked)

- **Live voice trusts the browser for usage numbers and the setup frame.** Fix in M3: a server-issued `voice_session_id`, ephemeral tokens with locked config, and a duration-based usage floor (`docs/verification.md` Q1, Q2).
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
