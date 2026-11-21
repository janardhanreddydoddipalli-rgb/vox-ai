"""POST /internal/users/upsert: service credential, idempotency, and hidden from OpenAPI."""

import pytest
from httpx import AsyncClient

from tests.conftest import INTERNAL_TOKEN

URL = "/internal/users/upsert"
AUTH = {"X-Internal-Token": INTERNAL_TOKEN}


@pytest.mark.parametrize(
    "headers", [{}, {"X-Internal-Token": "wrong-token-0123456789abcdefghijkl"}, {"X-Internal-Token": ""}]
)
async def test_rejects_missing_or_wrong_credential(client: AsyncClient, headers: dict[str, str]) -> None:
    res = await client.post(URL, headers=headers, json={"email": "a@example.com"})
    assert res.status_code == 401
    assert res.headers["content-type"] == "application/problem+json"


async def test_upsert_is_idempotent_and_returns_a_stable_id(client: AsyncClient) -> None:
    first = await client.post(URL, headers=AUTH, json={"email": "a@example.com", "name": "Ada"})
    second = await client.post(URL, headers=AUTH, json={"email": "a@example.com"})
    assert first.status_code == second.status_code == 200
    assert first.json()["user_id"] == second.json()["user_id"]


async def test_upsert_updates_provided_fields_and_keeps_missing_ones(
    client: AsyncClient, mint_token: object
) -> None:
    uid = (
        await client.post(
            URL, headers=AUTH, json={"email": "b@example.com", "name": "Old", "image": "https://i/1"}
        )
    ).json()["user_id"]
    await client.post(URL, headers=AUTH, json={"email": "b@example.com", "name": "New"})
    token = mint_token(uid)  # type: ignore[operator]
    me = (await client.get("/v1/me", headers={"Authorization": f"Bearer {token}"})).json()
    assert me["name"] == "New"
    assert me["image"] == "https://i/1"


async def test_rejects_unknown_fields(client: AsyncClient) -> None:
    res = await client.post(URL, headers=AUTH, json={"email": "c@example.com", "is_admin": True})
    assert res.status_code == 422


async def test_internal_routes_are_not_in_the_public_openapi(client: AsyncClient) -> None:
    paths = (await client.get("/openapi.json")).json()["paths"]
    assert not any(p.startswith("/internal") for p in paths)
    assert "/v1/me" in paths
