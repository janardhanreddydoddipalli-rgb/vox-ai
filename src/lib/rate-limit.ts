import { NextRequest, NextResponse } from "next/server";

// Per-identity rate limiting. Prod: Upstash Redis Ratelimit when its env vars
// are set; dev/test: in-memory sliding window. Same interface either way, so
// routes never change.

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

// Upstash-backed limiter for production: shared across serverless instances.
// One Ratelimit per (limit, window) policy, each with its own key prefix, so
// routes with different limits never share counters. Fails open on Upstash
// errors: an outage of the limiter must not take the product down.
async function createUpstashLimiter(url: string, token: string): Promise<RateLimiter> {
  const [{ Ratelimit }, { Redis }] = await Promise.all([import("@upstash/ratelimit"), import("@upstash/redis")]);
  const redis = new Redis({ url, token });
  const byPolicy = new Map<string, InstanceType<typeof Ratelimit>>();
  return {
    async check(key, limit, windowMs) {
      const policy = `${limit}:${windowMs}`;
      let rl = byPolicy.get(policy);
      if (!rl) {
        rl = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(limit, `${windowMs} ms`), prefix: `vox:rl:${policy}` });
        byPolicy.set(policy, rl);
      }
      try {
        const r = await rl.limit(key);
        const retryAfterSec = r.success ? 0 : Math.max(1, Math.ceil((r.reset - Date.now()) / 1000));
        return { ok: r.success, retryAfterSec };
      } catch (err) {
        console.error("[rate-limit] Upstash check failed; allowing request", err);
        return { ok: true, retryAfterSec: 0 };
      }
    },
  };
}

// Backend is chosen once per process, on first use: Upstash when its env vars
// are set, otherwise the in-memory limiter (dev/test). Lazy rather than set
// from instrumentation, because Next.js does not guarantee instrumentation and
// route handlers share module state.
let override: RateLimiter | null = null;
let active: Promise<RateLimiter> | null = null;

function activeLimiter(): Promise<RateLimiter> {
  if (override) return Promise.resolve(override);
  if (!active) {
    const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    if (url && token) {
      active = createUpstashLimiter(url, token);
    } else {
      if (process.env.NODE_ENV === "production") {
        console.warn("[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set; using per-instance in-memory limiter");
      }
      active = Promise.resolve(new SlidingWindowLimiter());
    }
  }
  return active;
}

// Test hook: force a specific limiter (null restores env-based selection).
export function setRateLimiter(l: RateLimiter | null) {
  override = l;
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
  const { ok, retryAfterSec } = await (await activeLimiter()).check(key, limit, WINDOW_MS);
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
