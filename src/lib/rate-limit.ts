import { NextRequest, NextResponse } from "next/server";

// Per-identity rate limiting. Dev/default: in-memory sliding window.
// Prod: Upstash Redis Ratelimit, wired via setUpstashRateLimiter() —
// same interface either way, so routes never change.

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfterSec: number }>;
}

class SlidingWindowLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();

  async check(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const windowStart = now - windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > windowStart);
    if (arr.length >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
      this.hits.set(key, arr); // drop expired entries
      return { ok: false, retryAfterSec };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10000) this.gc(windowStart);
    return { ok: true, retryAfterSec: 0 };
  }

  private gc(windowStart: number) {
    for (const [k, v] of this.hits) {
      const kept = v.filter((t) => t > windowStart);
      if (kept.length === 0) this.hits.delete(k);
      else this.hits.set(k, kept);
    }
  }
}

export let rateLimiter: RateLimiter = new SlidingWindowLimiter();

export function setRateLimiter(l: RateLimiter) {
  rateLimiter = l;
}

// Upstash-backed limiter for prod. Called at server startup (instrumentation)
// when Upstash env vars are present.
export async function setUpstashRateLimiter(): Promise<void> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  const [{ Ratelimit }, { Redis }] = await Promise.all([import("@upstash/ratelimit"), import("@upstash/redis")]);
  const ratelimit = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    prefix: "vox:rl",
  });
  rateLimiter = {
    async check(key) {
      const r = await ratelimit.limit(key);
      const retryAfterSec = r.success ? 0 : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000));
      return { ok: r.success, retryAfterSec };
    },
  };
}

const CHAT_LIMIT = 30; // requests
const WINDOW_MS = 60_000;

export function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

// Identity key: user id when signed in, IP for anonymous callers.
export async function rateLimitKey(req: NextRequest, name: string, userId?: string | null): Promise<string> {
  return userId ? `${name}:user:${userId}` : `${name}:ip:${clientIp(req)}`;
}

// Returns a 429 response when limited, or null when allowed.
export async function checkRate(
  req: NextRequest,
  name: string,
  userId?: string | null,
  limit = CHAT_LIMIT,
): Promise<NextResponse | null> {
  const key = await rateLimitKey(req, name, userId);
  const { ok, retryAfterSec } = await rateLimiter.check(key, limit, WINDOW_MS);
  if (ok) return null;
  return NextResponse.json(
    { error: "Too many requests. Please slow down." },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

// Same-origin check: the browser always sends Origin on POSTs. Non-browser
// clients (tests, curl) may omit it; those are allowed.
export function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function blockedOrigin(): NextResponse {
  return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
}
