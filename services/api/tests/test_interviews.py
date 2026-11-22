"""Interviews (ported from apps/web /api/interviews*, dashboard and report pages)."""

import json
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from httpx import AsyncClient

from tests.conftest import resume_pdf
from tests.helpers import (
    count_rows,
    fetch_one,
    insert_interview,
    insert_qa,
    insert_user,
    insert_voice_session,
)
from vox_api.llm.fake import FakeProvider

Mint = Callable[..., str]
REPORT = {
    "overall": 7.5,
    "strengths": ["Clear structure"],
    "gaps": ["Indexes"],
    "summary": "Solid answers overall.",
    "perQuestion": [{"question": "Q", "score": 7.5, "better_answer": "A model answer."}],
}
MEMORIES = {"memories": [{"kind": "weakness", "text": "Shaky on database indexes."}]}


def auth(mint: Mint, user_id: uuid.UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {mint(user_id)}"}


# --- create ------------------------------------------------------------------


async def test_create_without_resume(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(None)
    me = await insert_user(database_url)
    res = await client.post(
        "/v1/interviews",
        data={"role": "Backend Engineer", "level": "senior", "language": "hi"},
        headers=auth(mint_token, me),
    )
    assert res.status_code == 201
    row = await fetch_one(database_url, "select * from interviews where id = $1", uuid.UUID(res.json()["id"]))
    assert row is not None
    assert (row["role"], row["level"], row["language"], row["status"]) == (
        "Backend Engineer",
        "senior",
        "hi",
        "active",
    )
    assert row["resume_id"] is None


async def test_create_with_resume_and_job_description_indexes_both_and_meters_usage(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    structure = {
        "skills": ["Python", "SQL"],
        "projects": [{"name": "Vox", "summary": "Voice app"}],
        "experience": [],
    }
    use_llm(FakeProvider(replies=[json.dumps(structure)]))
    me = await insert_user(database_url)
    pdf = resume_pdf(
        ["Ada Lovelace", "Skills: Python, SQL", "Built Vox, a voice interview app with RAG search."]
    )
    jd = "We need a backend engineer who knows Postgres, queues and caching in production systems."

    res = await client.post(
        "/v1/interviews",
        data={"role": "Backend Engineer", "level": "mid", "job_description": jd},
        files={"resume": ("cv.pdf", pdf, "application/pdf")},
        headers=auth(mint_token, me),
    )

    assert res.status_code == 201
    resume = await fetch_one(database_url, "select * from resumes where user_id = $1", me)
    assert resume is not None
    assert json.loads(str(resume["skills"])) == ["Python", "SQL"]
    assert "Skills: Python, SQL" in str(resume["raw_text"])
    assert await count_rows(database_url, "doc_chunks", "user_id = $1 and source = 'resume'", me) >= 1
    assert await count_rows(database_url, "doc_chunks", "user_id = $1 and source = 'jd'", me) == 1
    usage = await fetch_one(
        database_url, "select tokens_in, tokens_out from token_usage where user_id = $1", me
    )
    assert usage is not None
    assert int(str(usage["tokens_in"])) > 0
    assert int(str(usage["tokens_out"])) > 0


async def test_create_with_resume_and_no_model_uses_the_heuristic(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(None)
    me = await insert_user(database_url)
    res = await client.post(
        "/v1/interviews",
        data={"role": "Frontend", "level": "junior"},
        files={"resume": ("cv.pdf", resume_pdf(["Skills: React, CSS, TypeScript"]), "application/pdf")},
        headers=auth(mint_token, me),
    )
    assert res.status_code == 201
    resume = await fetch_one(database_url, "select skills from resumes where user_id = $1", me)
    assert resume is not None
    assert json.loads(str(resume["skills"])) == ["React", "CSS", "TypeScript"]
    assert await count_rows(database_url, "doc_chunks", "user_id = $1", me) == 0  # no model: no embeddings


@pytest.mark.parametrize(
    ("file", "detail"),
    [
        (("cv.txt", b"plain text", "text/plain"), "Resume must be a PDF"),
        (("cv.pdf", b"%PDF-1.4 garbage", "application/pdf"), "Could not read text from that PDF"),
        (("cv.pdf", b"0" * 5_000_001, "application/pdf"), "Resume PDF must be 5 MB or smaller"),
    ],
)
async def test_bad_resumes_are_400(
    client: AsyncClient,
    mint_token: Mint,
    database_url: str,
    use_llm: Callable[[Any], None],
    file: tuple[str, bytes, str],
    detail: str,
) -> None:
    use_llm(None)
    me = await insert_user(database_url)
    res = await client.post(
        "/v1/interviews",
        data={"role": "X", "level": "mid"},
        files={"resume": file},
        headers=auth(mint_token, me),
    )
    assert res.status_code == 400
    assert res.json()["detail"] == detail
    assert await count_rows(database_url, "interviews", "user_id = $1", me) == 0


@pytest.mark.parametrize(
    "data",
    [
        {"level": "mid"},
        {"role": "X", "level": "guru"},
        {"role": "X", "level": "mid", "language": "fr"},
        {"role": " ", "level": "mid"},
    ],
)
async def test_invalid_forms_are_422(
    client: AsyncClient, mint_token: Mint, database_url: str, data: dict[str, str]
) -> None:
    me = await insert_user(database_url)
    res = await client.post("/v1/interviews", data=data, headers=auth(mint_token, me))
    assert res.status_code == 422


# --- read ------------------------------------------------------------------------


async def test_list_scores_and_detail(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    other = await insert_user(database_url)
    done = await insert_interview(database_url, me, role="Done", report=json.dumps(REPORT))
    await insert_qa(database_url, done, 0, "What is an index?", "A lookup structure.", score=8)
    await insert_interview(database_url, me, role="Active")
    await insert_interview(database_url, other, role="Not mine")

    listing = (await client.get("/v1/interviews", headers=auth(mint_token, me))).json()["interviews"]
    assert [i["role"] for i in listing] == ["Active", "Done"]
    assert listing[1]["overall"] == 7.5

    scores = (await client.get("/v1/interviews/scores", headers=auth(mint_token, me))).json()["scores"]
    assert [(s["interview_id"], s["order"], s["score"]) for s in scores] == [(str(done), 0, 8)]

    detail = (await client.get(f"/v1/interviews/{done}", headers=auth(mint_token, me))).json()
    assert detail["report"]["summary"] == "Solid answers overall."
    assert detail["qa"][0]["question"] == "What is an index?"
    assert detail["qa"][0]["evaluation"]["score"] == 8
    assert detail["has_resume"] is False


async def test_interviews_require_authentication(client: AsyncClient) -> None:
    assert (await client.get("/v1/interviews")).status_code == 401
    assert (await client.post("/v1/interviews", data={"role": "X", "level": "mid"})).status_code == 401
    assert (await client.get(f"/v1/interviews/{uuid.uuid4()}")).status_code == 401


# --- end + report + pdf -------------------------------------------------------------


async def test_end_without_answers_saves_the_empty_report_without_a_model_call(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = FakeProvider()
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)

    res = await client.post(f"/v1/interviews/{iv}/end", headers=auth(mint_token, me))

    assert res.status_code == 200
    assert res.json()["report"]["gaps"] == ["No answers were recorded."]
    assert llm.calls == []
    row = await fetch_one(database_url, "select status, completed_at from interviews where id = $1", iv)
    assert row is not None
    assert row["status"] == "complete"
    assert row["completed_at"] is not None


async def test_end_generates_report_and_memories_and_meters_usage(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = FakeProvider(replies=[json.dumps(REPORT), json.dumps(MEMORIES)])
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    await insert_qa(database_url, iv, 0, "What is an index?", "Something fast.", score=5)

    res = await client.post(f"/v1/interviews/{iv}/end", headers=auth(mint_token, me))

    assert res.status_code == 200
    assert res.json()["report"] == REPORT
    assert len(llm.calls) == 2
    assert "Write every field of the report in English" in str(llm.calls[0][0].text)
    assert await count_rows(database_url, "user_memories", "user_id = $1", me) == 1
    assert await count_rows(database_url, "token_usage", "user_id = $1 and tokens_in > 0", me) == 1

    again = await client.post(f"/v1/interviews/{iv}/end", headers=auth(mint_token, me))
    assert again.json()["report"] == REPORT
    assert len(llm.calls) == 2  # reused, not regenerated


async def test_end_keeps_the_report_when_memory_summary_fails(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(FakeProvider(replies=[json.dumps(REPORT), "not json"]))
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    await insert_qa(database_url, iv, 0, "Q", "A")

    res = await client.post(f"/v1/interviews/{iv}/end", headers=auth(mint_token, me))

    assert res.status_code == 200
    row = await fetch_one(database_url, "select status from interviews where id = $1", iv)
    assert row is not None
    assert row["status"] == "complete"
    assert await count_rows(database_url, "user_memories", "user_id = $1", me) == 0


@pytest.mark.parametrize("reply", ["not json", json.dumps({"overall": 99})])
async def test_end_is_502_when_the_model_fails_and_nothing_is_saved(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None], reply: str
) -> None:
    use_llm(FakeProvider(replies=[reply]))
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    await insert_qa(database_url, iv, 0, "Q", "A")

    res = await client.post(f"/v1/interviews/{iv}/end", headers=auth(mint_token, me))

    assert res.status_code == 502
    row = await fetch_one(database_url, "select status, report from interviews where id = $1", iv)
    assert row is not None
    assert (row["status"], row["report"]) == ("active", None)


async def test_report_pdf(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    assert (
        await client.get(f"/v1/interviews/{iv}/report.pdf", headers=auth(mint_token, me))
    ).status_code == 404

    await client.post(f"/v1/interviews/{iv}/end", headers=auth(mint_token, me))
    res = await client.get(f"/v1/interviews/{iv}/report.pdf", headers=auth(mint_token, me))

    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert res.headers["content-disposition"] == f'attachment; filename="vox-interview-{str(iv)[:8]}.pdf"'
    assert res.content.startswith(b"%PDF-1.4")
    assert b"No answers were recorded." in res.content


async def test_agent_steps(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    res = await client.get(f"/v1/interviews/{iv}/steps", headers=auth(mint_token, me))
    assert res.json() == {"steps": []}


# --- account -----------------------------------------------------------------------


async def test_sessions_and_delete_me(client: AsyncClient, mint_token: Mint, database_url: str) -> None:
    me = await insert_user(database_url)
    other = await insert_user(database_url)
    await client.post(
        "/v1/sessions/s-mine/turns",
        json={"turns": [{"role": "user", "text": "hi"}]},
        headers=auth(mint_token, me),
    )
    await insert_voice_session(database_url, me, await insert_interview(database_url, me))
    await insert_voice_session(database_url, other, await insert_interview(database_url, other))

    sessions = (await client.get("/v1/sessions", headers=auth(mint_token, me))).json()["sessions"]
    assert [s["id"] for s in sessions] == ["s-mine"]

    res = await client.delete("/v1/me", headers=auth(mint_token, me))
    assert res.json() == {"sessions_deleted": 1}
    assert await count_rows(database_url, "users", "id = $1", me) == 0
    assert await count_rows(database_url, "interviews", "user_id = $1", me) == 0
    assert await count_rows(database_url, "interviews", "user_id = $1", other) == 1
    assert await count_rows(database_url, "voice_sessions", "user_id = $1", me) == 0
    assert await count_rows(database_url, "voice_sessions", "user_id = $1", other) == 1
    assert (await client.get("/v1/me", headers=auth(mint_token, me))).status_code == 401
