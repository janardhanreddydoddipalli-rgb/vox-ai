"""Ephemeral Gemini Live tokens.

The browser streams audio to Gemini directly, so it gets a one-use token that
can open a session for two minutes; the API key never leaves the server.
"""

import datetime as dt
from typing import Protocol

import httpx

from vox_api.core.config import Settings
from vox_api.llm.base import LLMError
from vox_api.llm.gemini import BASE_URL

SESSION_WINDOW = dt.timedelta(minutes=2)
# A connected session keeps streaming after the window closes, up to this lifetime.
TOKEN_LIFETIME = dt.timedelta(minutes=30)


class LiveTokenMinter(Protocol):
    async def mint(self) -> str:
        """A fresh one-use Live API token name (auth_tokens/...)."""
        ...


def _rfc3339(t: dt.datetime) -> str:
    return t.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class GeminiLiveTokens:
    def __init__(self, api_key: str, *, client: httpx.AsyncClient | None = None) -> None:
        self._headers = {"x-goog-api-key": api_key}
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))

    async def mint(self) -> str:
        now = dt.datetime.now(dt.UTC)
        body = {
            "uses": 1,
            "expireTime": _rfc3339(now + TOKEN_LIFETIME),
            "newSessionExpireTime": _rfc3339(now + SESSION_WINDOW),
        }
        try:
            res = await self._client.post(f"{BASE_URL}/auth_tokens", headers=self._headers, json=body)
        except httpx.HTTPError as exc:
            raise LLMError(f"Live token request failed: {type(exc).__name__}") from exc
        if res.status_code != 200:
            raise LLMError(f"Live token mint failed: HTTP {res.status_code}")
        name = res.json().get("name")
        if not isinstance(name, str) or not name:
            raise LLMError("Live token response had no name")
        return name


def build_live_tokens(settings: Settings) -> LiveTokenMinter | None:
    """None when no Gemini key is configured: live voice is unavailable."""
    if settings.gemini_api_key is None or not settings.gemini_api_key.get_secret_value().strip():
        return None
    return GeminiLiveTokens(settings.gemini_api_key.get_secret_value().strip())
