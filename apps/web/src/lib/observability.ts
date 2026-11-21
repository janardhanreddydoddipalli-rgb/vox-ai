// Shared error-monitoring helpers. Sentry sees ids and code-path context
// only: never transcript text, resume content or any interview payload
// (enforced again by scrubVoxEvent in src/instrumentation.ts).
import * as Sentry from "@sentry/nextjs";

// Attach the app's own user id to the current Sentry scope. No email, name
// or any user content — just the uuid.
export function setSentryUser(userId: string | null | undefined) {
  if (!userId) return;
  Sentry.setUser({ id: userId });
}

export function captureVoxError(error: unknown, context?: Record<string, unknown>) {
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
