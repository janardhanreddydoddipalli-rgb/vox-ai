// Sentry server-side initialization (Next.js instrumentation hook). The SDK
// is inert until SENTRY_DSN is set, so local dev and tests pay nothing.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN?.trim() || undefined,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? "development",
    release: process.env.SENTRY_RELEASE ?? undefined,
    // We attach only the user id — never transcript text, resume content or
    // any interview payload. (v11 has no sendDefaultPii option; scrubbing is
    // enforced in beforeSend below and setSentryUser only sets { id }.)
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    beforeSend(event) {
      return scrubVoxEvent(event);
    },
  });
}

// Requests that end in an unhandled error are reported with route context.
export const onRequestError = Sentry.captureRequestError;

// Defense in depth: strip anything that could carry transcript/resume text
// from an event before it leaves the process. Sentry should see ids and
// messages from our own code paths, never user content.
export function scrubVoxEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  const REQUEST_BODY_KEYS = new Set(["userText", "answerText", "resumeText", "text", "jobDescription"]);
  if (event.request?.data && typeof event.request.data === "object") {
    const data = event.request.data as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (REQUEST_BODY_KEYS.has(key)) data[key] = "[removed]";
    }
  }
  return event;
}
