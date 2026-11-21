"""Per-route, per-user rate limiting: Upstash in production, in-memory in dev and tests.

Same buckets as apps/web (prefix vox:rl:<limit>:<windowMs>, key <route>:user:<id>), so a
route keeps its limit while traffic moves between the two apps. Fails open if Upstash
is unreachable: an outage of the limiter must not take the product down.
"""

import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Protocol

import structlog
from upstash_ratelimit.asyncio import Ratelimit, SlidingWindow
from upstash_redis.asyncio import Redis

from vox_api.core.config import Settings

log = structlog.get_logger("vox_api.rate_limit")


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    retry_after_s: int = 0


class RateLimiter(Protocol):
    async def check(self, key: str, limit: int, window_s: int) -> RateDecision: ...


class InMemoryRateLimiter:
    """Sliding window per key, per process. Dev and tests only."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}

    async def check(self, key: str, limit: int, window_s: int) -> RateDecision:
        now = time.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - window_s:
            hits.popleft()
        if len(hits) >= limit:
            return RateDecision(False, max(1, math.ceil(hits[0] + window_s - now)))
        hits.append(now)
        return RateDecision(True)


class UpstashRateLimiter:
    def __init__(self, url: str, token: str) -> None:
        self._redis = Redis(url=url, token=token)
        self._policies: dict[tuple[int, int], Ratelimit] = {}

    async def check(self, key: str, limit: int, window_s: int) -> RateDecision:
        policy = (limit, window_s)
        rl = self._policies.get(policy)
        if rl is None:
            rl = Ratelimit(
                redis=self._redis,
                limiter=SlidingWindow(max_requests=limit, window=window_s, unit="s"),
                prefix=f"vox:rl:{limit}:{window_s * 1000}",
            )
            self._policies[policy] = rl
        try:
            res = await rl.limit(key)
        except Exception as exc:  # fail open on any limiter error
            log.error("rate_limit_unavailable", error_type=type(exc).__name__)
            return RateDecision(True)
        if res.allowed:
            return RateDecision(True)
        reset_s = res.reset / 1000 if res.reset > 1e11 else res.reset  # ms or s epoch
        return RateDecision(False, max(1, math.ceil(reset_s - time.time())))


def build_rate_limiter(settings: Settings) -> RateLimiter:
    if settings.upstash_redis_rest_url and settings.upstash_redis_rest_token:
        return UpstashRateLimiter(
            settings.upstash_redis_rest_url, settings.upstash_redis_rest_token.get_secret_value()
        )
    if settings.environment == "production":
        log.warning("rate_limit_in_memory", reason="UPSTASH_REDIS_REST_URL/TOKEN not set")
    return InMemoryRateLimiter()
