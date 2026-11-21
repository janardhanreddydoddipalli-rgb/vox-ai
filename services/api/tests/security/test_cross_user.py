"""Cross-user access returns 404 and changes nothing, for every route with an {id}.

Each test is registered in test_route_ownership.CROSS_USER_TESTS.
"""

import uuid
from collections.abc import Callable

from httpx import AsyncClient

from tests.helpers import count_rows, insert_memory, insert_user

Mint = Callable[..., str]


async def test_delete_memory_of_another_user_is_404(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    owner = await insert_user(database_url)
    attacker = await insert_user(database_url)
    memory_id = await insert_memory(database_url, owner, "private weakness")

    res = await client.delete(
        f"/v1/memories/{memory_id}", headers={"Authorization": f"Bearer {mint_token(attacker)}"}
    )

    assert res.status_code == 404
    assert "private weakness" not in res.text
    assert await count_rows(database_url, "user_memories", "id = $1", memory_id) == 1


async def test_cross_user_ids_never_leak_existence(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    """Another user's id and a random id are indistinguishable."""
    owner = await insert_user(database_url)
    attacker = await insert_user(database_url)
    memory_id = await insert_memory(database_url, owner, "x")
    headers = {"Authorization": f"Bearer {mint_token(attacker)}"}
    theirs = await client.delete(f"/v1/memories/{memory_id}", headers=headers)
    random = await client.delete(f"/v1/memories/{uuid.uuid4()}", headers=headers)
    assert theirs.status_code == random.status_code == 404
    assert theirs.json()["detail"] == random.json()["detail"]


async def test_post_turns_into_another_users_session_is_404(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    owner = await insert_user(database_url)
    attacker = await insert_user(database_url)
    sid = f"s-{uuid.uuid4().hex[:10]}"
    await client.post(
        f"/v1/sessions/{sid}/turns",
        json={"turns": [{"role": "user", "text": "owner private answer"}]},
        headers={"Authorization": f"Bearer {mint_token(owner)}"},
    )

    res = await client.post(
        f"/v1/sessions/{sid}/turns",
        json={"turns": [{"role": "user", "text": "injected"}]},
        headers={"Authorization": f"Bearer {mint_token(attacker)}"},
    )

    assert res.status_code == 404
    assert "owner private answer" not in res.text
    assert await count_rows(database_url, "turns", "session_id = $1", sid) == 1


async def test_get_turns_of_another_users_session_is_404(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    owner = await insert_user(database_url)
    attacker = await insert_user(database_url)
    sid = f"s-{uuid.uuid4().hex[:10]}"
    await client.post(
        f"/v1/sessions/{sid}/turns",
        json={"turns": [{"role": "user", "text": "owner private answer"}]},
        headers={"Authorization": f"Bearer {mint_token(owner)}"},
    )
    res = await client.get(
        f"/v1/sessions/{sid}/turns", headers={"Authorization": f"Bearer {mint_token(attacker)}"}
    )
    assert res.status_code == 404
    assert "owner private answer" not in res.text
