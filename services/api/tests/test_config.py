from typing import Any

import pytest
from pydantic import ValidationError

from vox_api.core.config import Settings, async_database_url


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        # Neon's connection string: libpq params → asyncpg's ssl, channel_binding dropped.
        (
            "postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
            "postgresql+asyncpg://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?ssl=require",
        ),
        ("postgres://u:p@localhost:5432/vox", "postgresql+asyncpg://u:p@localhost:5432/vox"),
        ("postgresql://u:p@h/db?sslmode=disable", "postgresql+asyncpg://u:p@h/db"),
        ("postgresql+asyncpg://u:p@h/db?ssl=require", "postgresql+asyncpg://u:p@h/db?ssl=require"),
    ],
)
def test_async_database_url(given: str, expected: str) -> None:
    assert async_database_url(given) == expected


def test_async_database_url_rejects_other_schemes() -> None:
    with pytest.raises(ValueError, match="postgres"):
        async_database_url("mysql://u:p@h/db")


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": "postgresql://u:p@h/db",
        "web_origin": "https://vox.example.com",
        "jwt_public_key": "-----BEGIN PUBLIC KEY-----\\nabc\\n-----END PUBLIC KEY-----",
        "internal_api_token": "x" * 32,
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)


def test_settings_fail_fast_without_required_values(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("DATABASE_URL", "WEB_ORIGIN", "JWT_PUBLIC_KEY", "INTERNAL_API_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as exc:
        Settings(_env_file=None)
    missing = {e["loc"][0] for e in exc.value.errors()}
    assert missing == {"database_url", "web_origin", "jwt_public_key", "internal_api_token"}


def test_internal_token_must_be_long() -> None:
    with pytest.raises(ValidationError):
        _settings(internal_api_token="short")


@pytest.mark.parametrize(
    "origin", ["vox.example.com", "https://vox.example.com/app", "ftp://vox.example.com"]
)
def test_web_origin_must_be_a_bare_origin(origin: str) -> None:
    with pytest.raises(ValidationError):
        _settings(web_origin=origin)


def test_pem_with_escaped_newlines_is_restored() -> None:
    assert _settings().jwt_public_key_pem.splitlines()[0] == "-----BEGIN PUBLIC KEY-----"
