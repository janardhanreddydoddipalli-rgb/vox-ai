"""Shared FastAPI dependencies: settings, a per-request DB session, and the current user."""

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Annotated

from fastapi import Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.core.config import Settings
from vox_api.core.db import session_scope
from vox_api.core.errors import ProblemError
from vox_api.core.rate_limit import RateLimiter
from vox_api.core.security import InvalidTokenError, internal_token_matches, verify_access_token
from vox_api.models import User
from vox_api.observability.sentry import set_user
from vox_api.repositories import users as users_repo

_BEARER_CHALLENGE = {"WWW-Authenticate": 'Bearer realm="vox-api"'}
_bearer = HTTPBearer(auto_error=False, description="5-minute EdDSA JWT from apps/web /api/token")


def get_app_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async for session in session_scope(request.app.state.session_factory):
        yield session


SettingsDep = Annotated[Settings, Depends(get_app_settings)]
DbSession = Annotated[AsyncSession, Depends(get_db)]


async def get_current_user(
    settings: SettingsDep,
    db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    """The user named by a valid bearer token. Every failure is the same 401."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise ProblemError(401, "Missing bearer token", headers=_BEARER_CHALLENGE)
    try:
        principal = verify_access_token(credentials.credentials, settings)
    except InvalidTokenError as exc:
        raise ProblemError(401, "Invalid or expired token", headers=_BEARER_CHALLENGE) from exc
    user = await users_repo.get_by_id(db, principal.user_id)
    if user is None:  # deleted after the token was minted
        raise ProblemError(401, "Unknown user", headers=_BEARER_CHALLENGE)
    set_user(str(user.id))
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def require_internal_token(
    settings: SettingsDep,
    x_internal_token: Annotated[str | None, Header()] = None,
) -> None:
    """Service-to-service credential for /internal/* (constant-time compare)."""
    if not internal_token_matches(x_internal_token, settings):
        raise ProblemError(401, "Invalid service credential")


def rate_limited(name: str, limit: int, window_s: int = 60) -> Callable[..., Awaitable[None]]:
    """Dependency: at most `limit` calls per `window_s` per user for this route."""

    async def _check(request: Request, user: CurrentUser) -> None:
        limiter: RateLimiter = request.app.state.rate_limiter
        decision = await limiter.check(f"{name}:user:{user.id}", limit, window_s)
        if not decision.allowed:
            raise ProblemError(
                429,
                "Too many requests. Please slow down.",
                headers={"Retry-After": str(decision.retry_after_s)},
            )

    return _check
