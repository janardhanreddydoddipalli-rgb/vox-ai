"""Ephemeral Live token minting against a mocked Gemini endpoint (no network)."""

import datetime as dt
import json

import httpx
import pytest
from pydantic import SecretStr

from vox_api.core.config import Settings
from vox_api.llm.base import LLMError
from vox_api.llm.live import GeminiLiveTokens, build_live_tokens


def minter(handler: httpx.MockTransport) -> GeminiLiveTokens:
    return GeminiLiveTokens("test-key", client=httpx.AsyncClient(transport=handler))


async def test_mint_requests_a_one_use_token_with_both_lifetimes() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"name": "auth_tokens/abc"})

    assert await minter(httpx.MockTransport(handle)).mint() == "auth_tokens/abc"
    req = seen[0]
    assert req.url.path.endswith("/v1beta/auth_tokens")
    assert req.headers["x-goog-api-key"] == "test-key"
    body = json.loads(req.content)
    assert body["uses"] == 1
    now = dt.datetime.now(dt.UTC)
    expire = dt.datetime.fromisoformat(body["expireTime"])
    window = dt.datetime.fromisoformat(body["newSessionExpireTime"])
    assert dt.timedelta(minutes=29) < expire - now <= dt.timedelta(minutes=30)
    assert dt.timedelta(minutes=1) < window - now <= dt.timedelta(minutes=2)


@pytest.mark.parametrize(
    "response",
    [httpx.Response(403, json={"error": {"message": "denied"}}), httpx.Response(200, json={})],
)
async def test_mint_failures_raise_llm_error(response: httpx.Response) -> None:
    with pytest.raises(LLMError):
        await minter(httpx.MockTransport(lambda _: response)).mint()


async def test_network_errors_raise_llm_error_without_the_key() -> None:
    def boom(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unreachable")

    with pytest.raises(LLMError) as info:
        await minter(httpx.MockTransport(boom)).mint()
    assert "test-key" not in str(info.value)


def test_no_key_means_no_live_voice() -> None:
    base = {
        "_env_file": None,
        "database_url": SecretStr("postgresql://u:p@localhost/x"),
        "web_origin": "http://localhost:3000",
        "jwt_public_key": SecretStr("unused"),
        "internal_api_token": SecretStr("x" * 32),
    }
    assert build_live_tokens(Settings(**base)) is None  # type: ignore[arg-type]
    assert build_live_tokens(Settings(**base, gemini_api_key=SecretStr("  "))) is None  # type: ignore[arg-type]
    assert isinstance(build_live_tokens(Settings(**base, gemini_api_key=SecretStr("k"))), GeminiLiveTokens)  # type: ignore[arg-type]
