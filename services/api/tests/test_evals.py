"""The eval harness: its pure checks, and one case run end to end on the fake provider (no paid call)."""

import json
from typing import Any

from evals.checks import (
    estimate_cost,
    no_invented_questions,
    norm,
    question_sentences,
    spoken_length,
    weak_follow_up,
)
from evals.run import run_case

from tests.helpers import count_rows, insert_user
from tests.test_agent import EVALUATION, bank_question, call, say
from vox_api.llm.fake import FakeProvider


def test_question_sentences_and_normalisation() -> None:
    reply = "Good point. What is an index? Walk me through a B-tree. It is fast."
    assert question_sentences(reply) == ["What is an index?", "Walk me through a B-tree."]
    assert norm("  What's   an INDEX?! ") == "what s an index"


def test_no_invented_questions_accepts_paraphrases_of_tool_questions() -> None:
    outputs: list[dict[str, Any]] = [
        {"question": "What is a database index?"},
        {"follow_up_question": "How is it stored?"},
    ]
    assert no_invented_questions("Let's start. What is a database index?", outputs).passed
    # No question mark and no interrogative opening: not counted as a question.
    assert no_invented_questions("How is it stored", outputs).passed
    bad = no_invented_questions("Why did you leave your last job?", outputs)
    assert not bad.passed
    assert "invented" in bad.detail


def test_spoken_length_rejects_long_or_markdown_replies() -> None:
    assert spoken_length("Short and spoken.").passed
    assert not spoken_length("word " * 81).passed
    assert not spoken_length("Here:\n- a bullet").passed
    assert not spoken_length("This is **bold**").passed


def test_weak_follow_up_and_cost() -> None:
    assert weak_follow_up("Could you go deeper on idempotency keys?", True).passed
    assert not weak_follow_up("Thanks, moving on.", True).passed
    assert estimate_cost(1_000_000, 1_000_000) == 2.0


async def test_one_case_runs_end_to_end_and_meters_its_tokens(database_url: str, app: Any) -> None:
    question = await bank_question(database_url)
    me = await insert_user(database_url)
    llm = FakeProvider(
        replies=[json.dumps({**EVALUATION, "score": 2})],
        turns=[
            call("get_question", role="Engineer", level="mid"),
            say("What is a database index?"),
            say("Can you say more?"),
        ],
    )
    case = {
        "id": "weak-x",
        "tag": "weak",
        "category": "backend",
        "question": "What is idempotency?",
        "answer": "Not sure.",
        "expected_score_min": 1,
        "expected_score_max": 4,
        "expect_follow_up": True,
    }

    result = await run_case(case, app.state.session_factory, llm, me)

    assert [c.name for c in result.checks] == [
        "score-in-range",
        "follow-up-policy",
        "step-limit",
        "reply-length-speech",
        "no-invented-questions",
        "weak-follow-up-asked",
    ]
    by_name = {c.name: c for c in result.checks}
    assert by_name["score-in-range"].passed
    assert by_name["step-limit"].passed
    assert result.tokens_in > 0
    assert await count_rows(database_url, "token_usage", "user_id = $1", me) == 1
    assert question  # the bank question the opening turn could ask
