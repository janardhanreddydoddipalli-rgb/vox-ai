"""The interview agent: POST /v1/interviews/{id}/turns (ported from apps/web agent-loop and chat tests)."""

import json
import random
import uuid
from collections.abc import Callable
from typing import Any

import asyncpg
import pytest
from httpx import AsyncClient

from tests.helpers import count_rows, dsn, fetch_one, insert_interview, insert_memory, insert_user
from tests.test_chat import read_sse
from vox_api.agent.loop import MAX_TOOL_STEPS
from vox_api.agent.tools.base import ToolContext
from vox_api.agent.tools.registry import TOOLS, tool_specs
from vox_api.llm.base import ModelTurn, ToolCall, Turn
from vox_api.llm.fake import FakeProvider

Mint = Callable[..., str]
EVALUATION = {
    "score": 6,
    "clarity": "Clear.",
    "depth": "Shallow.",
    "correctness": "Mostly right.",
    "missing_points": ["indexes"],
    "follow_up_needed": True,
    "follow_up_question": "How would you index it?",
}


def sent_results(llm: FakeProvider, request: int) -> list[tuple[str, Any]]:
    """The (tool name, result) pairs the agent sent back to the model in that request."""
    last = llm.turn_requests[request][0][-1]
    assert isinstance(last, Turn)
    return list(last.results)


def call(name: str, **args: Any) -> ModelTurn:
    return ModelTurn(text="", calls=[ToolCall(name, args)], tokens_in=10, tokens_out=2)


def say(text: str) -> ModelTurn:
    return ModelTurn(text=text, calls=[], tokens_in=10, tokens_out=5)


async def bank_question(
    database_url: str, text: str = "What is a database index?", category: str = "backend"
) -> str:
    conn = await asyncpg.connect(dsn(database_url))
    try:
        await conn.execute(
            "insert into questions (category, text) values ($1, $2) on conflict do nothing", category, text
        )
        return str(await conn.fetchval("select id from questions where text = $1", text))
    finally:
        await conn.close()


async def turn(
    client: AsyncClient, mint: Mint, user: uuid.UUID, iv: uuid.UUID, text: str = "hi"
) -> list[tuple[str, Any]]:
    res = await client.post(
        f"/v1/interviews/{iv}/turns",
        json={"user_text": text},
        headers={"Authorization": f"Bearer {mint(user)}"},
    )
    assert res.status_code == 200, res.text
    return read_sse(res.text)


async def test_a_turn_with_one_tool_call_streams_and_traces(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    await bank_question(database_url)
    llm = FakeProvider(
        turns=[call("get_question", role="Backend", level="mid"), say("Here it is. What is an index?")]
    )
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)

    events = await turn(client, mint_token, me, iv, "start please")

    names = [e for e, _ in events]
    assert names[0] == "meta"
    assert events[0][1]["mode"] == "interview"
    assert events[0][1]["interview_id"] == str(iv)
    assert [d["text"] for e, d in events if e == "sentence"] == ["Here it is.", "What is an index?"]
    assert (
        "tool",
        {"name": "get_question", "step": 0, "duration_ms": events[names.index("tool")][1]["duration_ms"]},
    ) in events
    done = events[-1]
    assert done[0] == "done"
    assert (done[1]["tool_steps"], done[1]["hit_step_limit"]) == (1, False)
    # The tool's result went back to the model; the step and the usage were saved.
    assert sent_results(llm, 1)[0][0] == "get_question"
    step = await fetch_one(
        database_url, "select tool_name, step_index from agent_steps where interview_id = $1", iv
    )
    assert step == {"tool_name": "get_question", "step_index": 0}
    assert await count_rows(database_url, "token_usage", "user_id = $1 and tokens_in = 20", me) == 1


async def test_evaluate_answer_saves_ordered_answers_and_meters_the_evaluation(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    qid = await bank_question(database_url)
    llm = FakeProvider(
        replies=[json.dumps(EVALUATION), json.dumps(EVALUATION)],
        turns=[
            call("evaluate_answer", question_id=qid, answer_text="It speeds up lookups."),
            say("Good start."),
            call("evaluate_answer", question_id=qid, answer_text="B-trees."),
            say("Nice."),
        ],
    )
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)

    await turn(client, mint_token, me, iv)
    await turn(client, mint_token, me, iv)

    conn = await asyncpg.connect(dsn(database_url))
    try:
        rows = await conn.fetch(
            'select "order", question_id, question_text from interview_qa where interview_id = $1 order by 1',
            iv,
        )
    finally:
        await conn.close()
    assert [(r["order"], r["question_id"], r["question_text"]) for r in rows] == [
        (0, qid, "What is a database index?"),
        (1, qid, "What is a database index?"),
    ]
    usage = await fetch_one(database_url, "select tokens_in from token_usage where user_id = $1", me)
    assert usage is not None
    assert int(str(usage["tokens_in"])) > 40  # loop rounds + the evaluation calls


async def test_resume_questions_can_be_evaluated(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    """Fixed bug: the web version rejected "resume:<id>:<n>" ids and lost the question text."""
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    conn = await asyncpg.connect(dsn(database_url))
    try:
        resume_id = await conn.fetchval(
            "insert into resumes (user_id, filename, raw_text, projects) values ($1, 'cv.pdf', 'x', $2::jsonb) returning id",
            me,
            json.dumps([{"name": "Vox", "summary": "A voice interview app."}]),
        )
        await conn.execute("update interviews set resume_id = $1 where id = $2", resume_id, iv)
    finally:
        await conn.close()
    use_llm(
        FakeProvider(
            replies=[json.dumps(EVALUATION)],
            turns=[
                call("get_question", role="Backend", level="mid", use_resume=True),
                call(
                    "evaluate_answer", question_id=f"resume:{resume_id}:0", answer_text="I built it with RAG."
                ),
                say("Thanks."),
            ],
        )
    )

    events = await turn(client, mint_token, me, iv)

    assert events[-1][1]["tool_steps"] == 2
    qa = await fetch_one(
        database_url, "select question_id, question_text from interview_qa where interview_id = $1", iv
    )
    assert qa == {
        "question_id": None,
        "question_text": "Tell me about your work on Vox. A voice interview app.",
    }


async def test_bad_tool_calls_come_back_as_errors_and_the_turn_continues(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = FakeProvider(
        replies=["not json"],
        turns=[
            call("get_question", role="Backend", level="guru"),
            call("launch_missiles"),
            call("evaluate_answer", question_id=str(uuid.uuid4()), answer_text="x"),
            say("Sorry, let's try again."),
        ],
    )
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)

    events = await turn(client, mint_token, me, iv)

    assert events[-1][0] == "done"
    results = [sent_results(llm, i)[0][1] for i in range(1, len(llm.turn_requests))]
    assert results[0]["error"].startswith("Invalid arguments for get_question: level")
    assert results[1] == {"error": "Unknown tool: launch_missiles"}
    assert results[2]["error"].startswith("Unknown question_id")


async def test_a_failing_tool_is_reported_not_fatal(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    qid = await bank_question(database_url)
    llm = FakeProvider(
        replies=["not json"], turns=[call("evaluate_answer", question_id=qid, answer_text="x"), say("Hmm.")]
    )
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)

    events = await turn(client, mint_token, me, iv)

    assert events[-1][0] == "done"
    assert sent_results(llm, 1)[0][1]["error"].startswith("Tool evaluate_answer failed")
    assert await count_rows(database_url, "interview_qa", "interview_id = $1", iv) == 0


async def test_step_limit_forces_a_spoken_reply(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    await bank_question(database_url)
    llm = FakeProvider(
        replies=["Let us move on. Next question soon."],
        turns=[call("get_question", role="Backend", level="mid") for _ in range(MAX_TOOL_STEPS)],
    )
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)

    events = await turn(client, mint_token, me, iv)

    done = events[-1][1]
    assert (done["hit_step_limit"], done["tool_steps"]) == (True, MAX_TOOL_STEPS)
    assert [d["text"] for e, d in events if e == "sentence"] == ["Let us move on.", "Next question soon."]


async def test_end_interview_completes_it(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(FakeProvider(turns=[call("end_interview"), say("Great job today.")]))
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    await turn(client, mint_token, me, iv, "let's stop")
    row = await fetch_one(
        database_url, "select status, current_question_index from interviews where id = $1", iv
    )
    assert row == {"status": "complete", "current_question_index": 1}


async def test_system_prompt_has_language_and_known_weaknesses(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = FakeProvider(turns=[say("Hello.")])
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    conn = await asyncpg.connect(dsn(database_url))
    try:
        await conn.execute("update interviews set language = 'ta' where id = $1", iv)
    finally:
        await conn.close()
    await insert_memory(database_url, me, "Shaky on SQL joins")
    await insert_memory(database_url, me, "Clear communicator", kind="strength")

    await turn(client, mint_token, me, iv)

    system = str(llm.turn_requests[0][2])
    assert "Conduct this entire interview in தமிழ்" in system
    assert "- Shaky on SQL joins" in system
    assert "Clear communicator" not in system
    assert set(llm.turn_requests[0][1]) == {t.name for t in TOOLS}


async def test_budget_exceeded_stops_before_any_model_call(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = FakeProvider(turns=[say("never")])
    use_llm(llm)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    conn = await asyncpg.connect(dsn(database_url))
    try:
        await conn.execute(
            "insert into token_usage (user_id, day, tokens_in, tokens_out) values ($1, to_char(now() at time zone 'utc', 'YYYY-MM-DD'), 200000, 0)",
            me,
        )
    finally:
        await conn.close()

    events = await turn(client, mint_token, me, iv)

    assert events[-1][0] == "done"
    assert events[-1][1]["budget_exceeded"] is True
    assert "budget" in events[-1][1]["message"]
    assert llm.turn_requests == []


async def test_no_model_is_an_error_event(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(None)
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    events = await turn(client, mint_token, me, iv)
    assert events[-1] == ("error", {"message": "The interviewer hit a problem. Please try again."})


async def test_turns_require_auth_and_valid_bodies(
    client: AsyncClient, mint_token: Mint, database_url: str
) -> None:
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    assert (await client.post(f"/v1/interviews/{iv}/turns", json={"user_text": "hi"})).status_code == 401
    bad = await client.post(
        f"/v1/interviews/{iv}/turns",
        json={"user_text": ""},
        headers={"Authorization": f"Bearer {mint_token(me)}"},
    )
    assert bad.status_code == 422


async def test_memory_and_document_tools_only_see_the_users_own_data(database_url: str, app: Any) -> None:
    from vox_api.agent.loop import run_tool

    me = await insert_user(database_url)
    other = await insert_user(database_url)
    await insert_memory(database_url, me, "mine")
    await insert_memory(database_url, other, "not mine")
    async with app.state.session_factory() as db:
        ctx = ToolContext(db=db, llm=FakeProvider(), user_id=me, interview=None, rng=random.Random(0))
        memories = await run_tool("recall_memories", {"query": "anything"}, ctx)
        docs = await run_tool("search_documents", {"query": "anything"}, ctx)
    assert [m["text"] for m in memories["memories"]] == ["mine"]
    assert docs == {"chunks": []}


def test_tool_specs_use_geminis_schema_subset() -> None:
    specs = {s.name: s for s in tool_specs()}
    assert list(specs) == [
        "get_question",
        "evaluate_answer",
        "end_interview",
        "read_resume",
        "recall_memories",
        "search_documents",
    ]
    q = specs["get_question"].parameters
    assert q["required"] == ["role", "level"]
    assert q["properties"]["level"] == {"type": "string", "enum": ["junior", "mid", "senior"]}
    assert q["properties"]["asked_ids"] == {"type": "array", "items": {"type": "string"}}
    assert specs["end_interview"].parameters == {"type": "object", "properties": {}, "required": []}


@pytest.mark.parametrize(
    "bad", [{"user_text": "x" * 2001}, {"user_text": "hi", "history": [{"role": "x", "text": "y"}]}]
)
async def test_turn_body_limits(
    client: AsyncClient, mint_token: Mint, database_url: str, bad: dict[str, Any]
) -> None:
    me = await insert_user(database_url)
    iv = await insert_interview(database_url, me)
    res = await client.post(
        f"/v1/interviews/{iv}/turns", json=bad, headers={"Authorization": f"Bearer {mint_token(me)}"}
    )
    assert res.status_code == 422
