# ADR 0005: Host the API as a container in Singapore, next to Neon

- Status: Accepted (2026-11-22). **Not deployed yet**: the first deploy is M5 and needs approval.
- Date: 2026-11-22

## Context

- The production database is **Neon in Singapore (`ap-southeast-1`)**. From this machine in India a query takes about **47 ms**; from US regions, about 200–250 ms. An interview turn makes many queries, so the API must run in the **same region** as the database.
- The API serves long-lived requests: SSE replies (seconds), and from M3 the voice tool bridge and usage metering. That rules out hosts with short function timeouts.
- `infra/docker/api.Dockerfile` already produces a 79 MB non-root image with a health check. Any container host can run it.

## Options (all in Singapore)

| Host | Region | Fit | Notes |
|---|---|---|---|
| **Google Cloud Run** | `asia-southeast1` | ✅ Recommended | Scales to zero; request timeout up to 60 min (SSE OK); per-request billing; Secret Manager; easy custom domain. Min instances = 1 removes cold starts once traffic is real. |
| **Fly.io** | `sin` | ✅ Good | Always-on small machines, low latency; simple `fly deploy` of the same image; secrets via `fly secrets`. |
| **Render** | Singapore | ⚠️ Possible | Simple, but fewer regions and controls; free tier sleeps. |
| Vercel Functions | `sin1` | ❌ | Fine for the Next.js app, but Python containers and long SSE/voice requests don't fit its function model. |

## Decision (proposed)

- **Cloud Run in `asia-southeast1`**, image from `infra/docker/api.Dockerfile`. Secrets come from Secret Manager: `DATABASE_URL` (Neon **pooled**), `JWT_PUBLIC_KEY`, `INTERNAL_API_TOKEN`, `SENTRY_DSN`.
- **Migrations** run as a one-off job from the same image (`alembic upgrade head`) with the Neon **direct** URL, never at container startup. The first time, the existing database is **stamped** instead (runbook).
- **The web app moves next to them:** Vercel function region `sin1` (since M4 it has no database access; its server pages and sign-in call the API).

## Consequences

- **Trade-offs:** cold starts on scale-to-zero (≈1–2 s) until min instances is set; Google Cloud billing to manage. A budget alert is required, alongside the Gemini one.
- **The choice isn't locked in:** the container and env contract are host-agnostic, so moving to Fly.io means redeploying the same image.
- **To do at deploy time (M3):** a custom domain (e.g. `api.<domain>`) with TLS; `WEB_ORIGIN` set to the production web origin; health check path `/v1/health`, readiness `/v1/health/ready`.
