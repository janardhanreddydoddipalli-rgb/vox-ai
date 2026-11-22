"""Live-voice sessions (server-issued ids) and their idempotent tool calls (Alembic 0002)."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from vox_api.models.base import Base, CreatedAt, Str, UuidPk


class VoiceSession(Base):
    """One Gemini Live session. Tool calls and usage are keyed by this id, which the
    server issues, so the browser never chooses which interview a tool acts on."""

    __tablename__ = "voice_sessions"
    __table_args__ = (Index("voice_sessions_user_id_idx", "user_id"),)

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE", name="voice_sessions_user_id_fk"),
        nullable=False,
    )
    interview_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("interviews.id", ondelete="CASCADE", name="voice_sessions_interview_id_fk"),
    )
    created_at: Mapped[CreatedAt]
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Client-reported totals, kept per session for reconciliation (docs/verification.md Q1).
    tokens_in: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    tokens_out: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))


class VoiceToolCall(Base):
    """A tool call already executed in a session: a retried call_id returns this output."""

    __tablename__ = "voice_tool_calls"
    __table_args__ = (
        UniqueConstraint("voice_session_id", "call_id", name="voice_tool_calls_session_call_key"),
    )

    id: Mapped[UuidPk]
    voice_session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("voice_sessions.id", ondelete="CASCADE", name="voice_tool_calls_session_fk"),
        nullable=False,
    )
    call_id: Mapped[Str]
    tool_name: Mapped[str] = mapped_column(Text, nullable=False)
    output: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[CreatedAt]
