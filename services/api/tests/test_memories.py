"""GET /v1/memories and DELETE /v1/memories/{id} (ported from apps/web /api/memories)."""

import uuid
from collections.abc import Callable

from httpx import AsyncClient

from tests.helpers import count_rows, insert_memory, insert_user

Mint = Callable[..., str]


def auth(mint: Mint, user_id: uuid.UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {mint(user_id)}"}


async def test_list_returns_only_my_memories_newest_first(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    other = await insert_user(database_url)
    await insert_memory(database_url, me, "older", "strength", "2026-01-01T00:00:00Z")
    await insert_memory(database_url, me, "newer", "weakness", "2026-02-01T00:00:00Z")
    await insert_memory(database_url, other, "not mine")

    res = await client.get("/v1/memories", headers=auth(mint_token, me))

    assert res.status_code == 200
    memories = res.json()["memories"]
    assert [m["text"] for m in memories] == ["newer", "older"]
    assert set(memories[0]) == {"id", "kind", "text", "created_at"}
    assert memories[0]["kind"] == "weakness"


async def test_list_is_empty_for_a_new_user(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    res = await client.get("/v1/memories", headers=auth(mint_token, me))
    assert res.json() == {"memories": []}


async def test_memories_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/v1/memories")).status_code == 401
    assert (await client.delete(f"/v1/memories/{uuid.uuid4()}")).status_code == 401


async def test_delete_my_memory(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    memory_id = await insert_memory(database_url, me, "forget me")

    res = await client.delete(f"/v1/memories/{memory_id}", headers=auth(mint_token, me))

    assert res.status_code == 204
    assert await count_rows(database_url, "user_memories", "id = $1", memory_id) == 0


async def test_delete_unknown_memory_is_404(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    res = await client.delete(f"/v1/memories/{uuid.uuid4()}", headers=auth(mint_token, me))
    assert res.status_code == 404
    assert res.headers["content-type"] == "application/problem+json"


async def test_delete_with_a_malformed_id_is_422(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    res = await client.delete("/v1/memories/not-a-uuid", headers=auth(mint_token, me))
    assert res.status_code == 422


async def test_deletes_are_rate_limited(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    statuses = [
        (await client.delete(f"/v1/memories/{uuid.uuid4()}", headers=auth(mint_token, me))).status_code
        for _ in range(31)
    ]
    assert statuses[:30] == [404] * 30
    assert statuses[30] == 429
