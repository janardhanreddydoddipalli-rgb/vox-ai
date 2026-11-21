"""Playground history: POST/GET /v1/sessions/{id}/turns, GET /v1/turns (ported from /api/turns)."""

import uuid
from collections.abc import Callable
from typing import Any

import pytest
from httpx import AsyncClient

from tests.helpers import count_rows, insert_user

Mint = Callable[..., str]
SAMPLE = [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello!", "latency_ms": 120}]


def sid() -> str:
    return f"s-{uuid.uuid4().hex[:10]}"


def auth(mint: Mint, user_id: uuid.UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {mint(user_id)}"}


async def test_save_and_read_back_in_order(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    s = sid()
    turns = [{"role": "user" if i % 2 == 0 else "assistant", "text": f"t{i}"} for i in range(10)]

    res = await client.post(
        f"/v1/sessions/{s}/turns", json={"mode": "gemini", "turns": turns}, headers=auth(mint_token, me)
    )

    assert res.status_code == 200
    body = res.json()
    assert body["session_id"] == s
    assert [t["text"] for t in body["turns"]] == [f"t{i}" for i in range(10)]
    assert set(body["turns"][0]) == {
        "id", "session_id", "role", "text", "latency_ms", "stt_ms", "first_token_ms", "total_llm_ms",
        "tts_start_ms", "created_at",
    }  # fmt: skip


async def test_appending_to_my_session_keeps_earlier_turns(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    s = sid()
    await client.post(f"/v1/sessions/{s}/turns", json={"turns": SAMPLE}, headers=auth(mint_token, me))
    res = await client.post(
        f"/v1/sessions/{s}/turns",
        json={"turns": [{"role": "user", "text": "again"}]},
        headers=auth(mint_token, me),
    )
    assert [t["text"] for t in res.json()["turns"]] == ["hi", "hello!", "again"]


async def test_list_returns_only_my_sessions(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    other = await insert_user(database_url)
    mine, theirs = sid(), sid()
    await client.post(f"/v1/sessions/{mine}/turns", json={"turns": SAMPLE}, headers=auth(mint_token, me))
    await client.post(f"/v1/sessions/{theirs}/turns", json={"turns": SAMPLE}, headers=auth(mint_token, other))

    body = (await client.get("/v1/turns", headers=auth(mint_token, me))).json()

    assert body["sessions"] == [mine]
    assert {t["session_id"] for t in body["turns"]} == {mine}


async def test_read_one_of_my_sessions(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    s = sid()
    await client.post(f"/v1/sessions/{s}/turns", json={"turns": SAMPLE}, headers=auth(mint_token, me))
    res = await client.get(f"/v1/sessions/{s}/turns", headers=auth(mint_token, me))
    assert res.status_code == 200
    assert [t["text"] for t in res.json()["turns"]] == ["hi", "hello!"]


async def test_unknown_session_is_404(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    assert (await client.get(f"/v1/sessions/{sid()}/turns", headers=auth(mint_token, me))).status_code == 404


async def test_turns_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/v1/turns")).status_code == 401
    assert (await client.post(f"/v1/sessions/{sid()}/turns", json={"turns": SAMPLE})).status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"turns": [{"role": "robot", "text": "x"}]},
        {"turns": [{"role": "user", "text": "   "}]},
        {"turns": [{"role": "user", "text": "x" * 5001}]},
        {"turns": [{"role": "user", "text": "x", "latency_ms": -5}]},
        {"turns": [{"role": "user", "text": "x"}] * 201},
        {"mode": "telepathy", "turns": SAMPLE},
        {},
    ],
)
async def test_invalid_bodies_are_422(
    client: AsyncClient, mint_token: Mint, database_url: str, body: dict[str, Any]
) -> None:
    me = await insert_user(database_url)
    res = await client.post(f"/v1/sessions/{sid()}/turns", json=body, headers=auth(mint_token, me))
    assert res.status_code == 422


async def test_unsafe_session_ids_are_rejected(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    res = await client.post(
        f"/v1/sessions/{'x' * 65}/turns", json={"turns": SAMPLE}, headers=auth(mint_token, me)
    )
    assert res.status_code == 422


async def test_saving_is_rate_limited(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    s = sid()
    one = {"turns": [{"role": "user", "text": "x"}]}
    statuses = [
        (await client.post(f"/v1/sessions/{s}/turns", json=one, headers=auth(mint_token, me))).status_code
        for _ in range(31)
    ]
    assert statuses[:30] == [200] * 30
    assert statuses[30] == 429
    assert await count_rows(database_url, "turns", "session_id = $1", s) == 30
