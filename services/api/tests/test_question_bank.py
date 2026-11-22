"""The question bank ships with the API and seeds idempotently."""

from typing import Any

from tests.conftest import run_alembic
from tests.helpers import count_rows
from vox_api.core.config import async_database_url
from vox_api.core.db import create_engine, create_session_factory
from vox_api.services import question_bank


def test_the_bank_has_forty_questions_in_four_categories() -> None:
    bank = question_bank.load()
    assert len(bank) == 40
    assert {q["category"] for q in bank} == {"frontend", "backend", "dsa", "hr"}
    assert len({q["text"] for q in bank}) == 40


async def test_seeding_twice_adds_the_bank_once(make_database: Any) -> None:
    url = await make_database("bank")  # its own database: the shared one keeps its test questions
    run_alembic(url, "upgrade", "head")
    engine = create_engine(async_database_url(url))
    try:
        async with create_session_factory(engine)() as db:
            first = await question_bank.seed(db)
            second = await question_bank.seed(db)
            await db.commit()
    finally:
        await engine.dispose()
    assert (first, second) == (40, 0)
    assert await count_rows(url, "questions") == 40
