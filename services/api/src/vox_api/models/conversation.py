"""sessions and turns: free-form voice/chat history (the playground)."""

import uuid

from sqlalchemy import ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from vox_api.models.base import Base, CreatedAt, Str, UuidPk


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("sessions_user_id_idx", "user_id"),)

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE", name="sessions_user_id_users_id_fk")
    )
    mode: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'browser'::text"))
    created_at: Mapped[CreatedAt]


class Turn(Base):
    __tablename__ = "turns"
    __table_args__ = (Index("turns_session_id_idx", "session_id"),)

    # Column order follows the database (later migrations appended the
    # latency columns after created_at).
    id: Mapped[UuidPk]
    session_id: Mapped[str] = mapped_column(
        Text, ForeignKey("sessions.id", ondelete="CASCADE", name="turns_session_fk"), nullable=False
    )
    role: Mapped[Str]
    text: Mapped[Str]
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[CreatedAt]
    stt_ms: Mapped[int | None] = mapped_column(Integer)
    first_token_ms: Mapped[int | None] = mapped_column(Integer)
    total_llm_ms: Mapped[int | None] = mapped_column(Integer)
    tts_start_ms: Mapped[int | None] = mapped_column(Integer)
