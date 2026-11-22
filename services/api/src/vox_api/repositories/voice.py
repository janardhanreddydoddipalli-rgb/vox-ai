"""Voice sessions and their tool calls. Every session read starts from the user."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import VoiceSession, VoiceToolCall


async def create_session(
    db: AsyncSession, user_id: uuid.UUID, interview_id: uuid.UUID | None, expires_at: dt.datetime
) -> VoiceSession:
    session = VoiceSession(user_id=user_id, interview_id=interview_id, expires_at=expires_at)
    db.add(session)
    await db.flush()
    return session


async def get_owned(
    db: AsyncSession, user_id: uuid.UUID, session_id: uuid.UUID, *, lock: bool = False
) -> VoiceSession | None:
    """The user's session, or None. lock=True serialises tool calls within a session,
    so a duplicate call_id waits for the first call and then sees its stored output."""
    stmt = select(VoiceSession).where(VoiceSession.id == session_id, VoiceSession.user_id == user_id)
    if lock:
        stmt = stmt.with_for_update()
    return (await db.scalars(stmt)).first()


async def get_call(db: AsyncSession, session_id: uuid.UUID, call_id: str) -> VoiceToolCall | None:
    stmt = select(VoiceToolCall).where(
        VoiceToolCall.voice_session_id == session_id, VoiceToolCall.call_id == call_id
    )
    return (await db.scalars(stmt)).first()


async def save_call(
    db: AsyncSession, session_id: uuid.UUID, call_id: str, tool_name: str, output: dict[str, Any]
) -> None:
    db.add(VoiceToolCall(voice_session_id=session_id, call_id=call_id, tool_name=tool_name, output=output))
    await db.flush()


async def add_tokens(db: AsyncSession, session_id: uuid.UUID, tokens_in: int, tokens_out: int) -> None:
    await db.execute(
        update(VoiceSession)
        .where(VoiceSession.id == session_id)
        .values(
            tokens_in=VoiceSession.tokens_in + tokens_in,
            tokens_out=VoiceSession.tokens_out + tokens_out,
        )
    )
