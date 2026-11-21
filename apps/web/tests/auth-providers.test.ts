import { describe, it, expect, afterEach, vi } from "vitest";

// Google-only sign-in (docs/adr/0002-google-only-auth.md). Email magic links
// need a database adapter in the web app, which the architecture forbids, and
// Auth.js rejects an email provider without one (MissingAdapter).
const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "E2E_TEST_AUTH"] as const;

async function providerIds(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { authConfig } = await import("@/lib/auth");
  return authConfig.providers.map((p) => (typeof p === "function" ? p().id : p.id));
}

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("sign-in providers", () => {
  it("offers Google only, even when RESEND_API_KEY is set", async () => {
    const ids = await providerIds({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", RESEND_API_KEY: "re_test" });
    expect(ids).toEqual(["google"]);
  });

  it("adds the test credentials provider only when E2E_TEST_AUTH=1", async () => {
    expect(await providerIds({ E2E_TEST_AUTH: "1" })).toEqual(["credentials"]);
    expect(await providerIds({})).toEqual([]);
  });
});
