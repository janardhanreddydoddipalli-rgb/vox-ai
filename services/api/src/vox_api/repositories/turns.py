"""sessions/turns queries. Reads go through the caller's own session ids."""

import uuid
from collections.abc import Sequence

from sqlalchemy import func, insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import Session, Turn
from vox_api.schemas.turns import TurnIn


async def claim_session(db: AsyncSession, user_id: uuid.UUID, session_id: str, mode: str) -> bool:
    """Create the session for this user if new. True only if the user owns it."""
    await db.execute(
        pg_insert(Session)
        .values(id=session_id, user_id=user_id, mode=mode)
        .on_conflict_do_nothing(index_elements=["id"])
    )
    return await owns_session(db, user_id, session_id)


async def owns_session(db: AsyncSession, user_id: uuid.UUID, session_id: str) -> bool:
    owner = await db.scalar(select(Session.user_id).where(Session.id == session_id))
    return owner == user_id


async def add_turns(db: AsyncSession, session_id: str, turns: Sequence[TurnIn]) -> None:
    if not turns:
        return
    # clock_timestamp() (not the column default now(), fixed per transaction)
    # gives each row its own time, so turns saved together keep their order.
    rows = [{**t.model_dump(), "session_id": session_id, "created_at": func.clock_timestamp()} for t in turns]
    for row in rows:
        await db.execute(insert(Turn).values(**row))


async def turns_for_sessions(db: AsyncSession, session_ids: Sequence[str]) -> Sequence[Turn]:
    if not session_ids:
        return []
    stmt = select(Turn).where(Turn.session_id.in_(session_ids)).order_by(Turn.created_at, Turn.id)
    return (await db.scalars(stmt)).all()


async def session_ids_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[str]:
    stmt = select(Session.id).where(Session.user_id == user_id).order_by(Session.created_at.desc())
    return list((await db.scalars(stmt)).all())
