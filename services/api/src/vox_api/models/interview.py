"""résumés, interviews, answered questions (interview_qa), agent tool steps and the question bank."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from vox_api.models.base import Base, CreatedAt, OptStr, Str, UuidPk

_EMPTY_JSON_ARRAY = text("'[]'::jsonb")


def _user_fk(table: str) -> ForeignKey:
    return ForeignKey("users.id", ondelete="CASCADE", name=f"{table}_user_id_users_id_fk")


class Resume(Base):
    __tablename__ = "resumes"
    __table_args__ = (Index("resumes_user_id_idx", "user_id"),)

    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), _user_fk("resumes"), nullable=False)
    filename: Mapped[Str]
    raw_text: Mapped[Str]
    skills: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_JSON_ARRAY)
    projects: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=_EMPTY_JSON_ARRAY
    )
    experience: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default=_EMPTY_JSON_ARRAY
    )
    created_at: Mapped[CreatedAt]


class Interview(Base):
    __tablename__ = "interviews"
    __table_args__ = (Index("interviews_user_id_idx", "user_id"),)

    # Column order follows the database (resume_id onward were added by later migrations).
    id: Mapped[UuidPk]
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), _user_fk("interviews"), nullable=False)
    role: Mapped[Str]
    level: Mapped[Str]
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'::text"))
    current_question_index: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[CreatedAt]
    resume_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("resumes.id", ondelete="SET NULL", name="interviews_resume_id_resumes_id_fk"),
    )
    job_description: Mapped[OptStr]
    report: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    language: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'en'::text"))
    # The engine's state machine (engine/machine.py, Alembic 0004). state_version
    # increases on every persisted transition; failed_from is where `retry` returns.
    state: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'INTRO'::text"))
    state_version: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    state_entered_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    failed_from: Mapped[OptStr]


def _interview_fk(table: str) -> ForeignKey:
    return ForeignKey("interviews.id", ondelete="CASCADE", name=f"{table}_interview_id_interviews_id_fk")


class InterviewQa(Base):
    __tablename__ = "interview_qa"
    __table_args__ = (
        Index("interview_qa_interview_id_idx", "interview_id"),
        Index("interview_qa_interview_order_key", "interview_id", "order", unique=True),
    )

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("interview_qa"), nullable=False
    )
    order: Mapped[int] = mapped_column(Integer, nullable=False)
    question_id: Mapped[OptStr]
    question_text: Mapped[Str]
    answer_text: Mapped[Str]
    evaluation: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[CreatedAt]


class AgentStep(Base):
    __tablename__ = "agent_steps"
    __table_args__ = (Index("agent_steps_interview_id_idx", "interview_id"),)

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("agent_steps"), nullable=False
    )
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_name: Mapped[Str]
    input: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    output: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[CreatedAt]


class Question(Base):
    """Shared question bank (reference data, not user-owned)."""

    __tablename__ = "questions"
    __table_args__ = (UniqueConstraint("text", name="questions_text_unique"),)

    id: Mapped[UuidPk]
    category: Mapped[Str]
    text: Mapped[Str]
    created_at: Mapped[CreatedAt]
