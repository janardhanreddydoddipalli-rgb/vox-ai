"""Settings loaded from the environment; the app refuses to start without the required ones."""

from functools import lru_cache
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# libpq query parameters that asyncpg does not accept as connect() kwargs.
_LIBPQ_ONLY_PARAMS = {"channel_binding", "sslmode"}


def async_database_url(url: str) -> str:
    """Turn a libpq-style Postgres URL (as Neon hands out) into an asyncpg SQLAlchemy URL.

    ``postgresql://…?sslmode=require&channel_binding=require`` becomes
    ``postgresql+asyncpg://…?ssl=require``: asyncpg spells TLS as ``ssl`` and
    rejects ``channel_binding``.
    """
    parts = urlsplit(url)
    if parts.scheme not in {"postgres", "postgresql", "postgresql+asyncpg"}:
        raise ValueError("DATABASE_URL must be a postgres:// or postgresql:// URL")
    query = parse_qsl(parts.query, keep_blank_values=True)
    sslmode = next((v for k, v in query if k == "sslmode"), None)
    kept = [(k, v) for k, v in query if k not in _LIBPQ_ONLY_PARAMS]
    if sslmode and sslmode != "disable" and not any(k == "ssl" for k, _ in kept):
        kept.append(("ssl", sslmode))
    return urlunsplit(("postgresql+asyncpg", parts.netloc, parts.path, urlencode(kept), parts.fragment))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["development", "test", "staging", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # Postgres (Neon pooled URL in production). Converted for asyncpg.
    database_url: SecretStr

    # CORS: the one browser origin allowed to call the API (the web app).
    web_origin: str

    # Auth: EdDSA public key (PEM) that verifies tokens minted by apps/web.
    jwt_public_key: SecretStr
    jwt_issuer: str = "vox-web"
    jwt_audience: str = "vox-api"
    jwt_leeway_seconds: int = Field(default=30, ge=0, le=120)

    # Service credential for /internal/* (sent by apps/web as X-Internal-Token).
    internal_api_token: SecretStr = Field(min_length=32)

    # Shared rate limiting (same Upstash database as apps/web). Unset: in-memory.
    upstash_redis_rest_url: str | None = None
    upstash_redis_rest_token: SecretStr | None = None

    sentry_dsn: SecretStr | None = None
    sentry_traces_sample_rate: float = Field(default=0.0, ge=0.0, le=1.0)

    @field_validator("web_origin")
    @classmethod
    def _origin_has_no_path(cls, v: str) -> str:
        parts = urlsplit(v)
        if parts.scheme not in {"http", "https"} or not parts.netloc or parts.path not in {"", "/"}:
            raise ValueError("WEB_ORIGIN must be an origin like https://vox.example.com")
        return f"{parts.scheme}://{parts.netloc}"

    @property
    def async_database_url(self) -> str:
        return async_database_url(self.database_url.get_secret_value())

    @property
    def jwt_public_key_pem(self) -> str:
        # Env files often carry PEMs on one line with literal "\n".
        return self.jwt_public_key.get_secret_value().replace("\\n", "\n")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # values come from the environment
