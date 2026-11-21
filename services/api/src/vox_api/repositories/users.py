"""User queries. Lookups by id are the caller's own row (id comes from the verified token)."""

import uuid

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import User


async def get_by_id(db: AsyncSession, user_id: uuid.UUID) -> User | None:
    return await db.get(User, user_id)


async def upsert_by_email(db: AsyncSession, *, email: str, name: str | None, image: str | None) -> uuid.UUID:
    """Insert or update by email; returns the stable user id.

    A provided name/image replaces the stored one; a missing one keeps it.
    (apps/web's upsertUserByEmail overwrites them with NULL when omitted,
    which most of its callers do; see docs/backlog.md.)
    """
    insert_stmt = insert(User).values(email=email, name=name, image=image)
    upsert = insert_stmt.on_conflict_do_update(
        constraint="users_email_unique",
        set_={
            "name": func.coalesce(insert_stmt.excluded.name, User.name),
            "image": func.coalesce(insert_stmt.excluded.image, User.image),
        },
    ).returning(User.id)
    user_id: uuid.UUID = (await db.execute(upsert)).scalar_one()
    return user_id
