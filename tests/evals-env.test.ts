import { describe, it, expect } from "vitest";

// CI has no .env.local: the eval environment must fall back to process.env
// (GitHub secrets) instead of crashing on a missing file. EVALS_ENV_FILE
// points at a path that never exists, so the result doesn't depend on (or
// read) a developer's real .env.local.
describe("evals/env", () => {
  it("loads without an env file when the required env is already set", async () => {
    process.env.EVALS_ENV_FILE = "./this-env-file-does-not-exist.local";
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
    await expect(import("../evals/env")).resolves.toBeDefined();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
