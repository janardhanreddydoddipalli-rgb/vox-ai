"""user_memories queries. Every query is scoped to one user."""

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import UserMemory


async def list_for_user(db: AsyncSession, user_id: uuid.UUID) -> Sequence[UserMemory]:
    stmt = select(UserMemory).where(UserMemory.user_id == user_id).order_by(UserMemory.created_at.desc())
    return (await db.scalars(stmt)).all()


async def delete_for_user(db: AsyncSession, user_id: uuid.UUID, memory_id: uuid.UUID) -> bool:
    """True if the user's memory was deleted; False if it doesn't exist or isn't theirs."""
    stmt = (
        delete(UserMemory)
        .where(UserMemory.id == memory_id, UserMemory.user_id == user_id)
        .returning(UserMemory.id)
    )
    return (await db.execute(stmt)).scalar_one_or_none() is not None
