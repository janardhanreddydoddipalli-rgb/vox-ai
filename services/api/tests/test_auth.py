"""Bearer-token auth on /v1/me: the happy path and every way a token can be wrong."""

import base64
import datetime as dt
import hashlib
import hmac
import json
import uuid
from collections.abc import Callable

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from httpx import AsyncClient

from tests.conftest import public_pem

Mint = Callable[..., str]


async def test_me_returns_the_token_subject(
    client: AsyncClient, mint_token: Mint, user_id: uuid.UUID
) -> None:
    res = await client.get("/v1/me", headers={"Authorization": f"Bearer {mint_token(user_id)}"})
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == str(user_id)
    assert body["name"] == "Test User"


def _expired(mint: Mint, sub: uuid.UUID) -> str:
    past = dt.datetime.now(dt.UTC) - dt.timedelta(minutes=10)
    return mint(sub, iat=past, exp=past + dt.timedelta(minutes=5))  # expired 5 min ago (> 30 s leeway)


def _tampered(mint: Mint, sub: uuid.UUID) -> str:
    header, payload, signature = mint(sub).split(".")
    return f"{header}.{payload}.{signature[:-4]}AAAA"


def _hs256_with_public_key(mint: Mint, sub: uuid.UUID, key: Ed25519PrivateKey) -> str:
    """Algorithm-confusion attack: an HS256 token whose HMAC secret is our *public* key.

    Built by hand because PyJWT (rightly) refuses to sign HMAC with a PEM.
    """

    def b64(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    now = int(dt.datetime.now(dt.UTC).timestamp())
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(
        json.dumps(
            {"iss": "vox-web", "aud": "vox-api", "sub": str(sub), "jti": "x", "iat": now, "exp": now + 300}
        ).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    signature = hmac.new(public_pem(key).encode(), signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{b64(signature)}"


BAD_TOKENS: dict[str, Callable[[Mint, uuid.UUID, Ed25519PrivateKey], str]] = {
    "expired": lambda m, s, _k: _expired(m, s),
    "wrong_audience": lambda m, s, _k: m(s, aud="someone-else"),
    "wrong_issuer": lambda m, s, _k: m(s, iss="attacker"),
    "tampered_signature": lambda m, s, _k: _tampered(m, s),
    "signed_by_another_key": lambda m, s, _k: m(s, key=Ed25519PrivateKey.generate()),
    "alg_confusion_hs256": _hs256_with_public_key,
    "missing_jti": lambda m, s, _k: m(s, jti=None),
    "missing_exp": lambda m, s, _k: m(s, exp=None),
    "sub_not_a_uuid": lambda m, _s, _k: m("not-a-uuid"),
    "not_a_jwt": lambda _m, _s, _k: "definitely.not.a-jwt",
}


@pytest.mark.parametrize("case", sorted(BAD_TOKENS))
async def test_bad_tokens_are_401_problem(
    case: str, client: AsyncClient, mint_token: Mint, user_id: uuid.UUID, signing_key: Ed25519PrivateKey
) -> None:
    token = BAD_TOKENS[case](mint_token, user_id, signing_key)
    res = await client.get("/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401, res.text
    assert res.headers["content-type"] == "application/problem+json"
    assert res.headers["www-authenticate"].startswith("Bearer")
    assert res.json()["detail"] == "Invalid or expired token"


async def test_missing_token_is_401_problem(client: AsyncClient) -> None:
    res = await client.get("/v1/me")
    assert res.status_code == 401
    assert res.json()["detail"] == "Missing bearer token"


async def test_token_for_a_deleted_user_is_401(client: AsyncClient, mint_token: Mint) -> None:
    res = await client.get("/v1/me", headers={"Authorization": f"Bearer {mint_token(uuid.uuid4())}"})
    assert res.status_code == 401
    assert res.json()["detail"] == "Unknown user"


async def test_clock_skew_within_leeway_is_accepted(
    client: AsyncClient, mint_token: Mint, user_id: uuid.UUID
) -> None:
    now = dt.datetime.now(dt.UTC)
    token = mint_token(user_id, iat=now - dt.timedelta(minutes=5), exp=now - dt.timedelta(seconds=10))
    res = await client.get("/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
