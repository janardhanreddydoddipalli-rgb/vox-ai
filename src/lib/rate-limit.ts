import { NextRequest, NextResponse } from "next/server";

// Per-IP sliding-window rate limiter. In-memory for dev/single-instance;
// swap `checkRateLimit` for an Upstash-backed implementation in prod without
// touching the routes.

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterSec: number };
}

class SlidingWindowLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();

  check(key: string, limit: number, windowMs: number) {
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

// Exported so a prod deployment can register an Upstash/Redis-backed limiter.
export let rateLimiter: RateLimiter = new SlidingWindowLimiter();

export function setRateLimiter(l: RateLimiter) {
  rateLimiter = l;
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

// Returns a 429 response when limited, or null when allowed.
export function checkRate(req: NextRequest, name: string, limit = CHAT_LIMIT): NextResponse | null {
  const { ok, retryAfterSec } = rateLimiter.check(`${name}:${clientIp(req)}`, limit, WINDOW_MS);
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
