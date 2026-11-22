"""Alembic 0004 keeps every existing interview readable and resumable.

Builds a database at 0003 (the schema production has before the engine), writes
legacy interviews in each shape, upgrades, and checks the backfill. Downgrading
back to 0003 leaves the legacy data as it was.
"""

import json
import uuid
from typing import Any

import asyncpg

from tests.conftest import run_alembic
from tests.helpers import dsn

LEGACY_REPORT = {"overall": 7, "strengths": ["s"], "gaps": [], "summary": "ok", "perQuestion": []}


async def _seed_legacy(url: str) -> dict[str, uuid.UUID]:
    conn = await asyncpg.connect(dsn(url))
    try:
        user = await conn.fetchval("insert into users (email) values ('legacy@example.com') returning id")
        ids: dict[str, uuid.UUID] = {}
        ids["complete"] = await conn.fetchval(
            "insert into interviews (user_id, role, level, status, report, completed_at)"
            " values ($1, 'Backend', 'mid', 'complete', $2::jsonb, now()) returning id",
            user,
            json.dumps(LEGACY_REPORT),
        )
        ids["active_answered"] = await conn.fetchval(
            "insert into interviews (user_id, role, level) values ($1, 'Frontend', 'junior') returning id",
            user,
        )
        ids["active_new"] = await conn.fetchval(
            "insert into interviews (user_id, role, level) values ($1, 'DSA', 'senior') returning id", user
        )
        ids["long"] = await conn.fetchval(
            "insert into interviews (user_id, role, level, status) values ($1, 'Backend', 'mid', 'complete')"
            " returning id",
            user,
        )
        for iv, n in ((ids["complete"], 2), (ids["active_answered"], 1), (ids["long"], 5)):
            for order in range(n):
                await conn.execute(
                    'insert into interview_qa (interview_id, "order", question_id, question_text, answer_text,'
                    " evaluation) values ($1, $2, $3, 'Q', 'A', '{\"score\": 6}'::jsonb)",
                    iv,
                    order,
                    f"q-{order}",
                )
        return ids
    finally:
        await conn.close()


async def _rows(url: str, query: str, *args: Any) -> list[dict[str, Any]]:
    conn = await asyncpg.connect(dsn(url))
    try:
        return [dict(r) for r in await conn.fetch(query, *args)]
    finally:
        await conn.close()


async def test_upgrade_backfills_rounds_and_state_for_every_legacy_interview(make_database: Any) -> None:
    url = await make_database("m0004")
    run_alembic(url, "upgrade", "0003")
    ids = await _seed_legacy(url)
    run_alembic(url, "upgrade", "head")

    state = {
        r["id"]: r
        for r in await _rows(url, "select id, state, state_version, status, report from interviews")
    }
    assert state[ids["complete"]]["state"] == "LOOP_COMPLETE"
    assert json.loads(state[ids["complete"]]["report"]) == LEGACY_REPORT  # the old report is untouched
    assert state[ids["active_answered"]]["state"] == "NEXT_QUESTION"
    assert state[ids["active_new"]]["state"] == "INTRO"
    assert {r["state_version"] for r in state.values()} == {1}

    rounds = {
        r["interview_id"]: r
        for r in await _rows(
            url,
            "select interview_id, position, round_type, question_count, rubric_version, status,"
            " questions_asked, asked_ids from interview_rounds",
        )
    }
    assert len(rounds) == 4
    assert all(r["position"] == 0 and r["round_type"] == "technical" for r in rounds.values())
    done = rounds[ids["complete"]]
    assert (done["status"], done["rubric_version"], done["questions_asked"]) == ("complete", "legacy", 2)
    assert json.loads(done["asked_ids"]) == ["q-0", "q-1"]
    resumable = rounds[ids["active_answered"]]
    assert (resumable["status"], resumable["rubric_version"], resumable["questions_asked"]) == (
        "active",
        "technical-v1",
        1,
    )
    assert (rounds[ids["active_new"]]["status"], rounds[ids["active_new"]]["questions_asked"]) == (
        "pending",
        0,
    )
    assert rounds[ids["long"]]["question_count"] == 5  # never fewer than the answers already given

    history = await _rows(
        url, "select interview_id, seq, from_state, to_state, action from interview_transitions"
    )
    assert len(history) == 4
    assert all(h["seq"] == 1 and h["from_state"] == "LEGACY" and h["action"] == "migrate" for h in history)
    qa = await _rows(url, "select count(*) as n from interview_qa")
    assert qa[0]["n"] == 8  # answers untouched


async def test_downgrade_to_0003_keeps_the_legacy_data(make_database: Any) -> None:
    url = await make_database("m0004down")
    run_alembic(url, "upgrade", "0003")
    ids = await _seed_legacy(url)
    run_alembic(url, "upgrade", "head")
    run_alembic(url, "downgrade", "0003")

    rows = await _rows(url, "select id, status from interviews order by created_at")
    assert {r["id"] for r in rows} == set(ids.values())
    tables = await _rows(url, "select to_regclass('public.interview_rounds') is null as gone")
    assert tables[0]["gone"] is True
    assert (await _rows(url, "select count(*) as n from interview_qa"))[0]["n"] == 8


async def test_the_state_column_only_accepts_machine_states(make_database: Any) -> None:
    url = await make_database("m0004chk")
    run_alembic(url, "upgrade", "head")
    conn = await asyncpg.connect(dsn(url))
    try:
        user = await conn.fetchval("insert into users (email) values ('c@example.com') returning id")
        try:
            await conn.execute(
                "insert into interviews (user_id, role, level, state) values ($1, 'r', 'mid', 'BOGUS')", user
            )
        except asyncpg.CheckViolationError:
            pass
        else:
            raise AssertionError("an unknown state was accepted")
    finally:
        await conn.close()
