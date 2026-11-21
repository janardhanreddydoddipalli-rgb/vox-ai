import pytest

from vox_api.core.rate_limit import InMemoryRateLimiter, UpstashRateLimiter


async def test_in_memory_window_blocks_then_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [1000.0]
    monkeypatch.setattr("vox_api.core.rate_limit.time.monotonic", lambda: now[0])
    rl = InMemoryRateLimiter()

    assert (await rl.check("k", limit=2, window_s=60)).allowed
    assert (await rl.check("k", limit=2, window_s=60)).allowed
    blocked = await rl.check("k", limit=2, window_s=60)
    assert not blocked.allowed
    assert blocked.retry_after_s == 60

    now[0] += 61
    assert (await rl.check("k", limit=2, window_s=60)).allowed


async def test_in_memory_keys_are_independent() -> None:
    rl = InMemoryRateLimiter()
    assert (await rl.check("a", 1, 60)).allowed
    assert not (await rl.check("a", 1, 60)).allowed
    assert (await rl.check("b", 1, 60)).allowed


async def test_upstash_fails_open_when_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(self: object, identifier: str, rate: int = 1) -> object:
        raise ConnectionError("upstash down")

    monkeypatch.setattr("upstash_ratelimit.asyncio.Ratelimit.limit", boom)
    rl = UpstashRateLimiter("https://example.upstash.io", "token")
    assert (await rl.check("k", 1, 60)).allowed


async def test_upstash_uses_one_policy_per_limit_and_window(monkeypatch: pytest.MonkeyPatch) -> None:
    class Res:
        allowed = True
        reset = 0

    async def ok(self: object, identifier: str, rate: int = 1) -> Res:
        return Res()

    monkeypatch.setattr("upstash_ratelimit.asyncio.Ratelimit.limit", ok)
    rl = UpstashRateLimiter("https://example.upstash.io", "token")
    await rl.check("a", 30, 60)
    await rl.check("b", 30, 60)
    await rl.check("c", 5, 60)
    assert set(rl._policies) == {(30, 60), (5, 60)}
