"""The shared question bank: 40 questions across frontend, backend, DSA and HR (reference data)."""

import json
from importlib import resources

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import Question


def load() -> list[dict[str, str]]:
    raw = resources.files("vox_api.data").joinpath("question_bank.json").read_text(encoding="utf-8")
    bank: list[dict[str, str]] = json.loads(raw)
    return bank


async def seed(db: AsyncSession) -> int:
    """Insert the questions not there yet. Questions are unique on text, so re-running is a no-op.
    Returns how many were new."""
    stmt = (
        insert(Question).values(load()).on_conflict_do_nothing(index_elements=["text"]).returning(Question.id)
    )
    return len((await db.execute(stmt)).all())
