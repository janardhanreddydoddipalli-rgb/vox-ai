"use client";

// Rendered when the React tree itself throws. Reports to Sentry (client DSN)
// with the render error + component stack; shows a spoken-friendly reset.
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100dvh" }}>
        <div style={{ textAlign: "center" }}>
          <h1>Something went wrong</h1>
          <p>Vox hit an unexpected error. You can try again.</p>
          <button onClick={reset} style={{ padding: "0.5rem 1.25rem", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
