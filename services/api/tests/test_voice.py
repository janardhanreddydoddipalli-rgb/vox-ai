"""Live voice: POST /v1/voice/sessions, its tool bridge and usage reports
(ported from apps/web api-voice-tool, api-voice-usage, voice-session-* tests)."""

import datetime as dt
import json
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import asyncpg
import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from tests.helpers import count_rows, dsn, fetch_one, insert_interview, insert_user, insert_voice_session
from tests.test_agent import EVALUATION, bank_question
from vox_api.agent.tools.registry import TOOLS
from vox_api.llm.base import LLMError
from vox_api.llm.fake import FakeProvider

Mint = Callable[..., str]


class FakeLiveTokens:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.minted = 0

    async def mint(self) -> str:
        if self.fail:
            raise LLMError("Live token mint failed: HTTP 403")
        self.minted += 1
        return f"auth_tokens/fake-{self.minted}"


@pytest.fixture
def live(app: FastAPI) -> Iterator[FakeLiveTokens]:
    original = app.state.live_tokens
    app.state.live_tokens = FakeLiveTokens()
    yield app.state.live_tokens
    app.state.live_tokens = original


def auth(mint: Mint, user_id: uuid.UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {mint(user_id)}"}


async def spend(database_url: str, user_id: uuid.UUID, tokens: int) -> None:
    conn = await asyncpg.connect(dsn(database_url))
    try:
        await conn.execute(
            "insert into token_usage (user_id, day, tokens_in, tokens_out)"
            " values ($1, to_char(now() at time zone 'utc', 'YYYY-MM-DD'), $2, 0)",
            user_id,
            tokens,
        )
    finally:
        await conn.close()


async def tokens_today(database_url: str, user_id: uuid.UUID) -> int:
    row = await fetch_one(
        database_url, "select tokens_in + tokens_out as n from token_usage where user_id = $1", user_id
    )
    return int(str(row["n"])) if row else 0


# --- sessions -----------------------------------------------------------------


async def test_session_returns_token_prompt_and_tools_bound_to_the_interview(
    client: AsyncClient, mint_token: Mint, database_url: str, live: FakeLiveTokens
) -> None:
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    conn = await asyncpg.connect(dsn(database_url))
    try:
        await conn.execute("update interviews set language = 'hi' where id = $1", iv)
    finally:
        await conn.close()

    res = await client.post(
        "/v1/voice/sessions", json={"interview_id": str(iv)}, headers=auth(mint_token, me)
    )

    assert res.status_code == 201
    body = res.json()
    assert body["token"] == "auth_tokens/fake-1"
    assert body["model"] == "models/gemini-3.1-flash-live-preview"
    assert body["expires_in_sec"] == 1800
    assert "You are on a live voice call" in body["system_instruction"]
    assert "Conduct this entire interview in हिन्दी" in body["system_instruction"]  # the interview's language
    assert [t["name"] for t in body["tools"]] == [t.name for t in TOOLS]
    assert all(t["parameters"]["type"] == "object" for t in body["tools"])
    row = await fetch_one(
        database_url,
        "select user_id, interview_id, expires_at - now() as ttl from voice_sessions where id = $1",
        uuid.UUID(body["session_id"]),
    )
    assert row is not None
    assert (row["user_id"], row["interview_id"]) == (me, iv)
    assert dt.timedelta(minutes=59) < row["ttl"] <= dt.timedelta(minutes=60)  # type: ignore[operator]


async def test_session_without_an_interview_uses_the_requested_language(
    client: AsyncClient, mint_token: Mint, database_url: str, live: FakeLiveTokens
) -> None:
    me = await insert_user(database_url)
    res = await client.post("/v1/voice/sessions", json={"language": "ta"}, headers=auth(mint_token, me))
    assert res.status_code == 201
    assert "தமிழ்" in res.json()["system_instruction"]
    plain = await client.post("/v1/voice/sessions", json={}, headers=auth(mint_token, me))
    assert "LANGUAGE:" not in plain.json()["system_instruction"]


async def test_session_validation_and_auth(
    client: AsyncClient, mint_token: Mint, database_url: str, live: FakeLiveTokens
) -> None:
    me = await insert_user(database_url)
    assert (await client.post("/v1/voice/sessions", json={})).status_code == 401
    for bad in ({"language": "fr"}, {"interview_id": "nope"}):
        assert (
            await client.post("/v1/voice/sessions", json=bad, headers=auth(mint_token, me))
        ).status_code == 422
    assert live.minted == 0


async def test_session_over_budget_is_429_budget_exceeded_without_a_token(
    client: AsyncClient, mint_token: Mint, database_url: str, live: FakeLiveTokens
) -> None:
    me = await insert_user(database_url)
    await spend(database_url, me, 200_000)
    res = await client.post("/v1/voice/sessions", json={}, headers=auth(mint_token, me))
    assert res.status_code == 429
    assert res.json()["code"] == "budget_exceeded"
    assert "budget" in res.json()["detail"]
    assert live.minted == 0
    assert await count_rows(database_url, "voice_sessions", "user_id = $1", me) == 0


async def test_session_without_a_key_is_503_and_a_refused_mint_is_502(
    client: AsyncClient, mint_token: Mint, database_url: str, app: FastAPI, live: FakeLiveTokens
) -> None:
    me = await insert_user(database_url)
    app.state.live_tokens = None
    res = await client.post("/v1/voice/sessions", json={}, headers=auth(mint_token, me))
    assert (res.status_code, res.json()["detail"]) == (503, "Voice service is not configured")

    app.state.live_tokens = FakeLiveTokens(fail=True)
    res = await client.post("/v1/voice/sessions", json={}, headers=auth(mint_token, me))
    assert (res.status_code, res.json()["detail"]) == (502, "Could not start live voice")
    assert await count_rows(database_url, "voice_sessions", "user_id = $1", me) == 0


async def test_sessions_are_rate_limited_per_user(
    client: AsyncClient, mint_token: Mint, database_url: str, live: FakeLiveTokens
) -> None:
    me = await insert_user(database_url)
    statuses = [
        (await client.post("/v1/voice/sessions", json={}, headers=auth(mint_token, me))).status_code
        for _ in range(11)
    ]
    assert statuses == [201] * 10 + [429]


# --- tool calls ----------------------------------------------------------------


async def tool(
    client: AsyncClient, mint: Mint, user_id: uuid.UUID, sid: uuid.UUID, call_id: str, name: str, **args: Any
) -> Any:
    return await client.post(
        f"/v1/voice/sessions/{sid}/tool-calls",
        json={"call_id": call_id, "name": name, "args": args},
        headers=auth(mint, user_id),
    )


async def test_tool_call_runs_on_the_sessions_interview_and_is_traced(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(FakeProvider())
    qid = await bank_question(database_url)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    sid = await insert_voice_session(database_url, me, iv)

    res = await tool(client, mint_token, me, sid, "c1", "get_question", role="Backend Engineer", level="mid")

    assert res.status_code == 200
    assert res.json()["ok"] is True
    assert res.json()["result"]["question_id"] == qid
    step = await fetch_one(
        database_url, "select step_index, tool_name from agent_steps where interview_id = $1", iv
    )
    assert step == {"step_index": -1, "tool_name": "get_question"}
    assert await count_rows(database_url, "voice_tool_calls", "voice_session_id = $1", sid) == 1


async def test_a_retried_call_id_replays_without_running_the_tool_again(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = FakeProvider(replies=[json.dumps(EVALUATION), json.dumps({**EVALUATION, "score": 1})])
    use_llm(llm)
    qid = await bank_question(database_url)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    sid = await insert_voice_session(database_url, me, iv)

    first = await tool(
        client, mint_token, me, sid, "c1", "evaluate_answer", question_id=qid, answer_text="Faster reads."
    )
    again = await tool(
        client, mint_token, me, sid, "c1", "evaluate_answer", question_id=qid, answer_text="Faster reads."
    )

    assert first.json()["ok"] is True
    assert again.json() == first.json()
    assert len(llm.calls) == 1  # evaluated once
    assert await count_rows(database_url, "interview_qa", "interview_id = $1", iv) == 1
    assert await count_rows(database_url, "agent_steps", "interview_id = $1", iv) == 1
    assert await tokens_today(database_url, me) > 0  # the evaluation was metered

    other = await tool(client, mint_token, me, sid, "c1", "get_question", role="Backend", level="mid")
    assert other.status_code == 409


async def test_unknown_tools_and_bad_arguments_are_not_ok_and_not_stored(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(FakeProvider())
    me = await insert_user(database_url)
    sid = await insert_voice_session(database_url, me)

    unknown = await tool(client, mint_token, me, sid, "c1", "drop_tables")
    assert unknown.json() == {
        "ok": False,
        "result": None,
        "error": "Unknown tool: drop_tables",
        "message": None,
    }
    invalid = await tool(client, mint_token, me, sid, "c2", "get_question", role="", level="guru")
    assert invalid.json()["ok"] is False
    assert invalid.json()["error"].startswith("Invalid arguments for get_question:")
    assert await count_rows(database_url, "voice_tool_calls", "voice_session_id = $1", sid) == 0


async def test_tool_call_guards_expiry_model_budget_and_body(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(FakeProvider())
    me = await insert_user(database_url)
    expired = await insert_voice_session(database_url, me, expires_in=dt.timedelta(seconds=-1))
    res = await tool(client, mint_token, me, expired, "c1", "get_question", role="Backend", level="mid")
    assert (res.status_code, res.json()["detail"]) == (410, "Voice session expired")

    sid = await insert_voice_session(database_url, me)
    assert (
        await client.post(f"/v1/voice/sessions/{sid}/tool-calls", json={"call_id": "c", "name": "x"})
    ).status_code == 401
    bad = await client.post(
        f"/v1/voice/sessions/{sid}/tool-calls",
        json={"call_id": "", "name": "x"},
        headers=auth(mint_token, me),
    )
    assert bad.status_code == 422
    missing = await tool(
        client, mint_token, me, uuid.uuid4(), "c1", "get_question", role="Backend", level="mid"
    )
    assert missing.status_code == 404

    use_llm(None)
    res = await tool(client, mint_token, me, sid, "c1", "get_question", role="Backend", level="mid")
    assert res.status_code == 503

    use_llm(FakeProvider())
    await spend(database_url, me, 200_000)
    res = await tool(client, mint_token, me, sid, "c1", "get_question", role="Backend", level="mid")
    assert res.json()["ok"] is False
    assert res.json()["error"] == "budget_exceeded"
    assert "budget" in res.json()["message"]


# --- usage ---------------------------------------------------------------------


async def test_usage_is_metered_per_session_and_returns_the_budget_verdict(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    sid = await insert_voice_session(database_url, me)
    url = f"/v1/voice/sessions/{sid}/usage"

    first = await client.post(
        url, json={"prompt_tokens": 120, "response_tokens": 30}, headers=auth(mint_token, me)
    )
    assert first.status_code == 200
    assert first.json() == {"budget_exceeded": False, "message": None}
    second = await client.post(
        url, json={"prompt_tokens": 200_000, "response_tokens": 0}, headers=auth(mint_token, me)
    )
    assert second.json()["budget_exceeded"] is True
    assert "budget" in second.json()["message"]

    totals = await fetch_one(
        database_url, "select tokens_in, tokens_out from voice_sessions where id = $1", sid
    )
    assert totals == {"tokens_in": 200_120, "tokens_out": 30}
    assert await tokens_today(database_url, me) == 200_150


async def test_usage_bounds_auth_and_expired_sessions(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    sid = await insert_voice_session(database_url, me, expires_in=dt.timedelta(seconds=-1))
    url = f"/v1/voice/sessions/{sid}/usage"
    for bad in (
        {"prompt_tokens": 1_000_001, "response_tokens": 0},
        {"prompt_tokens": -1, "response_tokens": 0},
        {},
    ):
        assert (await client.post(url, json=bad, headers=auth(mint_token, me))).status_code == 422
    assert (await client.post(url, json={"prompt_tokens": 1, "response_tokens": 1})).status_code == 401
    # The spend was real, so an expired session still records it.
    ok = await client.post(
        url, json={"prompt_tokens": 10, "response_tokens": 5}, headers=auth(mint_token, me)
    )
    assert ok.status_code == 200
    assert await tokens_today(database_url, me) == 15
