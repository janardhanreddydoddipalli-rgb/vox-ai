// Sentry browser-side initialization (Next.js instrumentation-client hook).
// Inert until NEXT_PUBLIC_SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN?.trim() || undefined,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "development",
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? undefined,
  // Only the signed-in user's id is attached (see setVoxUser); no transcripts.
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
});
