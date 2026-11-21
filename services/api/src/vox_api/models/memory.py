"""Long-term memory and document chunks (768-dim Gemini embeddings in pgvector), plus token usage."""

import datetime as dt
import uuid

from pgvector.sqlalchemy import Vector
from sqlalchemy import DateTime, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from vox_api.models.base import Base, CreatedAt, Str, UuidPk

EMBEDDING_DIMENSIONS = 768


def _user_fk(table: str) -> ForeignKey:
    return ForeignKey("users.id", ondelete="CASCADE", name=f"{table}_user_id_users_id_fk")


class UserMemory(Base):
    __tablename__ = "user_memories"
    __table_args__ = (Index("user_memories_user_id_idx", "user_id"),)

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), _user_fk("user_memories"), nullable=False)
    kind: Mapped[Str]  # strength | weakness | preference
    text: Mapped[Str]
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    created_at: Mapped[CreatedAt]


class DocChunk(Base):
    __tablename__ = "doc_chunks"
    __table_args__ = (Index("doc_chunks_user_id_idx", "user_id"),)

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), _user_fk("doc_chunks"), nullable=False)
    source: Mapped[Str]  # resume | jd
    text: Mapped[Str]
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    created_at: Mapped[CreatedAt]


class TokenUsage(Base):
    """Per-user, per-UTC-day token counts for the cost guard. No message content."""

    __tablename__ = "token_usage"
    __table_args__ = (Index("token_usage_user_day_key", "user_id", "day", unique=True),)

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), _user_fk("token_usage"), nullable=False)
    day: Mapped[str] = mapped_column(Text, nullable=False)
    tokens_in: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    tokens_out: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
