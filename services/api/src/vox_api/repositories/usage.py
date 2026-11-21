"""token_usage: one row per user per UTC day. Counts only, never content."""

import datetime as dt
import uuid

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import TokenUsage


def today_utc() -> str:
    return dt.datetime.now(dt.UTC).date().isoformat()


async def tokens_used_today(db: AsyncSession, user_id: uuid.UUID) -> int:
    stmt = select(TokenUsage.tokens_in + TokenUsage.tokens_out).where(
        TokenUsage.user_id == user_id, TokenUsage.day == today_utc()
    )
    return int(await db.scalar(stmt) or 0)


async def add_usage(db: AsyncSession, user_id: uuid.UUID, tokens_in: int, tokens_out: int) -> None:
    stmt = insert(TokenUsage).values(
        user_id=user_id, day=today_utc(), tokens_in=tokens_in, tokens_out=tokens_out
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[TokenUsage.user_id, TokenUsage.day],
        set_={
            "tokens_in": TokenUsage.tokens_in + stmt.excluded.tokens_in,
            "tokens_out": TokenUsage.tokens_out + stmt.excluded.tokens_out,
            "updated_at": func.now(),
        },
    )
    await db.execute(stmt)
