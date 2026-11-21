import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as voiceToolPost } from "@/app/api/voice/tool/route";
import { POST as voiceSessionPost } from "@/app/api/voice/session/route";
import { setRateLimiter } from "@/lib/rate-limit";
import { upsertUserByEmail } from "@/lib/db";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

// Records every rate-limit check the routes make.
const checks: { key: string; limit: number }[] = [];

function post(url: string, body: unknown) {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

beforeEach(async () => {
  await resetDb();
  testAuth.asA();
  checks.length = 0;
  setRateLimiter({
    async check(key, limit) {
      checks.push({ key, limit });
      return { ok: true, retryAfterSec: 0 };
    },
  });
  // Ephemeral-token mint succeeds without touching the network.
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/test" }), { status: 200 })) as any;
});

afterEach(() => setRateLimiter(null));

describe("voice routes — dedicated rate-limit buckets", () => {
  it("/api/voice/tool uses its own bucket, keyed by user id, sized for a long live session", async () => {
    const user = await upsertUserByEmail("user-a@example.com");
    await voiceToolPost(post("/api/voice/tool", { name: "read_resume", args: {}, interviewId: null }));
    expect(checks).toEqual([{ key: `voice-tool:user:${user!.id}`, limit: 120 }]);
  });

  it("/api/voice/session uses its own bucket, keyed by user id", async () => {
    const user = await upsertUserByEmail("user-a@example.com");
    const res = await voiceSessionPost(post("/api/voice/session", { language: "en" }));
    expect(res.status).toBe(200);
    expect(checks).toEqual([{ key: `voice-session:user:${user!.id}`, limit: 10 }]);
  });

  it("live tool calls never consume the text chat bucket", async () => {
    await voiceToolPost(post("/api/voice/tool", { name: "read_resume", args: {}, interviewId: null }));
    expect(checks.some((c) => c.key.startsWith("chat:"))).toBe(false);
  });
});
