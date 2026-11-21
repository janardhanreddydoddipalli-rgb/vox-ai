import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.vercel.run"],
};

// Sentry config is inert without SENTRY_AUTH_TOKEN (source-map upload) — the
// build proceeds silently in local dev and CI.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
});
