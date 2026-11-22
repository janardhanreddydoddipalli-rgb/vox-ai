"""Long-term memory and document chunks (768-dim Gemini embeddings in pgvector), plus token usage."""

import datetime as dt
import uuid
from typing import Annotated

from pgvector.sqlalchemy import Vector
from sqlalchemy import Computed, DateTime, ForeignKey, Index, Integer, Text, text
from sqlalchemy.dialects.postgresql import TSVECTOR, UUID
from sqlalchemy.orm import Mapped, mapped_column

from vox_api.models.base import Base, CreatedAt, Str, UuidPk

EMBEDDING_DIMENSIONS = 768

# The model and size that produced each vector: vectors from different models are
# never compared. The defaults describe what apps/web still writes (expand phase;
# dropped when the web stops writing these tables in M4).
EmbeddingModel = Annotated[
    str, mapped_column(Text, nullable=False, server_default=text("'gemini-embedding-001'"))
]
EmbeddingDim = Annotated[int, mapped_column(Integer, nullable=False, server_default=text("768"))]


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
    embedding_model: Mapped[EmbeddingModel]
    embedding_dim: Mapped[EmbeddingDim]
    created_at: Mapped[CreatedAt]


class DocChunk(Base):
    __tablename__ = "doc_chunks"
    __table_args__ = (
        Index("doc_chunks_user_id_idx", "user_id"),
        Index("doc_chunks_tsv_idx", "tsv", postgresql_using="gin"),
    )

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), _user_fk("doc_chunks"), nullable=False)
    source: Mapped[Str]  # resume | jd
    text: Mapped[Str]
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIMENSIONS), nullable=False)
    embedding_model: Mapped[EmbeddingModel]
    embedding_dim: Mapped[EmbeddingDim]
    # Full-text side of hybrid retrieval. 'simple': no stemming, so Hindi, Tamil and
    # Telugu text match as well as English.
    tsv: Mapped[str | None] = mapped_column(
        TSVECTOR, Computed("to_tsvector('simple'::regconfig, text)", persisted=True)
    )
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
