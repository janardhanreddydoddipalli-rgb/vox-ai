import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";

// CI has no .env.local: the eval environment must fall back to process.env
// (GitHub secrets) instead of crashing on a missing file.
describe("evals/env", () => {
  it("loads without .env.local when the required env is already set", async () => {
    expect(existsSync(new URL("../.env.local", import.meta.url))).toBe(false);
    process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
    await expect(import("../evals/env")).resolves.toBeDefined();
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
  });
});
