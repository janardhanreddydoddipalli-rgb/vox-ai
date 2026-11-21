import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fake Upstash SDK: records each Ratelimit construction (one per policy) and
// routes .limit() through a shared mock so tests control the verdict.
const upstash = vi.hoisted(() => ({
  limit: vi.fn(),
  constructed: [] as { limiter: { tokens: number; window: string }; prefix: string }[],
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow(tokens: number, window: string) {
      return { tokens, window };
    }
    constructor(opts: { limiter: { tokens: number; window: string }; prefix: string }) {
      upstash.constructed.push(opts);
    }
    limit(key: string) {
      return upstash.limit(key);
    }
  }
  return { Ratelimit };
});
vi.mock("@upstash/redis", () => ({ Redis: class {} }));

function req() {
  return new Request("http://localhost:3000/api/chat", { method: "POST" }) as any;
}

async function freshRateLimit() {
  vi.resetModules();
  return import("@/lib/rate-limit");
}

beforeEach(() => {
  upstash.limit.mockReset();
  upstash.constructed.length = 0;
});

afterEach(() => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("rate limiter backend selection", () => {
  it("uses Upstash when UPSTASH env vars are set", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    upstash.limit.mockResolvedValue({ success: true, reset: Date.now() });
    const { checkRate } = await freshRateLimit();

    expect(await checkRate(req(), "chat", "u1")).toBeNull();
    expect(upstash.limit).toHaveBeenCalledWith("chat:user:u1");
  });

  it("falls back to the in-memory limiter without Upstash env vars", async () => {
    const { checkRate } = await freshRateLimit();
    for (let i = 0; i < 3; i++) expect(await checkRate(req(), "t", "u1", 3)).toBeNull();
    const blocked = await checkRate(req(), "t", "u1", 3);
    expect(blocked?.status).toBe(429);
    expect(upstash.limit).not.toHaveBeenCalled();
  });
});

describe("Upstash limiter", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  });

  it("honours the per-route limit: one Ratelimit per (limit, window) policy", async () => {
    upstash.limit.mockResolvedValue({ success: true, reset: Date.now() });
    const { checkRate } = await freshRateLimit();

    await checkRate(req(), "chat", "u1", 30);
    await checkRate(req(), "chat", "u2", 30);
    await checkRate(req(), "uploads", "u1", 5);

    expect(upstash.constructed.map((c) => c.limiter)).toEqual([
      { tokens: 30, window: "60000 ms" },
      { tokens: 5, window: "60000 ms" },
    ]);
    // Separate key spaces so policies never share counters.
    expect(new Set(upstash.constructed.map((c) => c.prefix)).size).toBe(2);
  });

  it("returns 429 with Retry-After when Upstash denies", async () => {
    upstash.limit.mockResolvedValue({ success: false, reset: Date.now() + 2500 });
    const { checkRate } = await freshRateLimit();

    const res = await checkRate(req(), "chat", "u1");
    expect(res?.status).toBe(429);
    expect(Number(res?.headers.get("Retry-After"))).toBeGreaterThanOrEqual(2);
  });

  it("fails open (allows) when Upstash is unreachable", async () => {
    upstash.limit.mockRejectedValue(new Error("network down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRate } = await freshRateLimit();

    expect(await checkRate(req(), "chat", "u1")).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
