# Backlog

Agreed work that's deliberately scheduled later. Each item becomes its own branch and PR.

## After M1

- **Upgrade to Next 16.** This fixes the bundled `postcss` advisory (`next@15.5.29` bundles `postcss@8.4.31`; `npm audit` reports it as high). It isn't reachable in production, because PostCSS only runs at build time on our own CSS. Also align `eslint-config-next` (currently 16.x) with `next`. Do it as a separate PR with a full regression pass (lint, typecheck, unit, E2E smoke, build, and a manual voice check).
- **Terms page (Phase 13, launch).** The footer link to `/terms` was removed because the page didn't exist (decision 2026-11-22). Add a Terms of Service page and restore the link at launch; `tests/internal-links.test.ts` will fail if the link returns before the page does.

- **Playground text mode.** When the mic or speech engine fails with a generic error, the playground shows "Could not start" instead of falling back to text mode (only `NotAllowedError`/`NotFoundError` trigger it), so browsers without speech support can't chat there.

- **Report PDFs in Hindi, Tamil and Telugu are unreadable.** The PDF writer (web and its API port) uses only the built-in Helvetica fonts and replaces non-ASCII characters with `?`. Fix: embed a Noto font for each script (e.g. via reportlab with TTF fonts) in `services/api/src/vox_api/services/report_pdf.py`.

- **Langfuse tracing for API agent turns.** The web agent's Langfuse traces went with it in M4. services/api records tool steps (`agent_steps`) and usage (`token_usage`) but sends no traces. Add the Langfuse Python SDK behind `LANGFUSE_*` env vars in the API (metadata only, never transcripts), with `prompt_version` on every trace.

## After M4

- **Contract migrations after M5:** once the old web version is gone from production, drop the `embedding_model` / `embedding_dim` server defaults on `user_memories` and `doc_chunks` (the API always sets them).
- **Per-state tool allowlist** for the interview state machine (CLAUDE.md target).
- Live voice: a duration-based usage floor per voice session (once Q1 says how `usageMetadata` counts) and locked ephemeral tokens (Q2). `voice_sessions` keeps per-session token totals for this.
- Rebuild email magic-link sign-in in FastAPI (ADR 0002 follow-up).
