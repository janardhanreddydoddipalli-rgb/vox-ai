"""Verify the short-lived EdDSA JWTs minted by apps/web (/api/token). Public key only."""

import hmac
import uuid
from dataclasses import dataclass

import jwt

from vox_api.core.config import Settings

# Only EdDSA is accepted: the algorithm is fixed here, never taken from the
# token header, so alg=none / HS256-with-public-key confusion cannot work.
ALGORITHMS = ["EdDSA"]
REQUIRED_CLAIMS = ["exp", "iat", "sub", "jti", "iss", "aud"]


class InvalidTokenError(Exception):
    """The bearer token is missing, malformed, expired or not ours."""


@dataclass(frozen=True)
class Principal:
    user_id: uuid.UUID
    token_id: str


def verify_access_token(token: str, settings: Settings) -> Principal:
    try:
        claims = jwt.decode(
            token,
            settings.jwt_public_key_pem,
            algorithms=ALGORITHMS,
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            leeway=settings.jwt_leeway_seconds,
            options={"require": REQUIRED_CLAIMS},
        )
        user_id = uuid.UUID(str(claims["sub"]))
    except (jwt.PyJWTError, ValueError) as exc:
        raise InvalidTokenError(type(exc).__name__) from exc
    return Principal(user_id=user_id, token_id=str(claims["jti"]))


def internal_token_matches(presented: str | None, settings: Settings) -> bool:
    """Constant-time comparison of the service credential."""
    if not presented:
        return False
    expected = settings.internal_api_token.get_secret_value()
    return hmac.compare_digest(presented.encode(), expected.encode())
