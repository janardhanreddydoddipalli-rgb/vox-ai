"""Interview engine tables (Alembic 0004): rounds, transitions, transcript, turns, evaluations."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy import text as sql
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from vox_api.models.base import Base, CreatedAt, OptStr, Str, UuidPk

_EMPTY_OBJECT = sql("'{}'::jsonb")
_EMPTY_ARRAY = sql("'[]'::jsonb")


def _interview_fk(table: str) -> ForeignKey:
    return ForeignKey("interviews.id", ondelete="CASCADE", name=f"{table}_interview_id_fk")


def _round_fk(table: str) -> ForeignKey:
    return ForeignKey("interview_rounds.id", ondelete="CASCADE", name=f"{table}_round_id_fk")


class InterviewRound(Base):
    """One ordered round of an interview loop. Legacy interviews were given one round."""

    __tablename__ = "interview_rounds"
    __table_args__ = (UniqueConstraint("interview_id", "position", name="interview_rounds_position_key"),)

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("interview_rounds"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    round_type: Mapped[Str]
    question_count: Mapped[int] = mapped_column(Integer, nullable=False)
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    follow_up_depth: Mapped[int] = mapped_column(Integer, nullable=False)
    rubric_version: Mapped[Str]
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql("'pending'::text"))
    questions_asked: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql("0"))
    follow_ups_used: Mapped[int] = mapped_column(Integer, nullable=False, server_default=sql("0"))
    # The question currently put to the candidate: {question_id, text, seq}.
    current_question: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    asked_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_ARRAY)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[CreatedAt]


class InterviewTransition(Base):
    """Append-only history of every state change (seq = the interview's state_version after it)."""

    __tablename__ = "interview_transitions"
    __table_args__ = (UniqueConstraint("interview_id", "seq", name="interview_transitions_seq_key"),)

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("interview_transitions"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    from_state: Mapped[Str]
    to_state: Mapped[Str]
    action: Mapped[Str]
    actor: Mapped[Str]  # server | model | candidate
    round_position: Mapped[int | None] = mapped_column(Integer)
    turn_id: Mapped[OptStr]
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_OBJECT)
    created_at: Mapped[CreatedAt]


class TranscriptSegment(Base):
    """What was said, as persisted by the server. Evaluation evidence must quote these."""

    __tablename__ = "transcript_segments"
    __table_args__ = (Index("transcript_segments_round_seq_idx", "round_id", "question_seq"),)

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("transcript_segments"), nullable=False
    )
    round_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _round_fk("transcript_segments"), nullable=False
    )
    question_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    speaker: Mapped[Str]  # interviewer | candidate
    text: Mapped[Str]
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default=sql("'text'::text"))
    turn_id: Mapped[OptStr]
    created_at: Mapped[CreatedAt]


class EngineTurn(Base):
    """A processed candidate turn, kept so a retried request replays instead of re-running."""

    __tablename__ = "engine_turns"
    __table_args__ = (UniqueConstraint("interview_id", "turn_id", name="engine_turns_turn_key"),)

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("engine_turns"), nullable=False
    )
    turn_id: Mapped[Str]
    request_hash: Mapped[Str]
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[CreatedAt]


class AnswerEvaluation(Base):
    """One evaluation attempt of one question's answer, with the rubric and model that produced it."""

    __tablename__ = "answer_evaluations"
    __table_args__ = (
        UniqueConstraint("round_id", "question_seq", "attempt", name="answer_evaluations_attempt_key"),
    )

    id: Mapped[UuidPk]
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _interview_fk("answer_evaluations"), nullable=False
    )
    round_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), _round_fk("answer_evaluations"), nullable=False
    )
    question_seq: Mapped[int] = mapped_column(Integer, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[Str]  # scored | insufficient_evidence | invalid | failed
    rubric_version: Mapped[Str]
    prompt_version: Mapped[Str]
    model: Mapped[Str]
    score: Mapped[float | None] = mapped_column(Float)  # 0..10, computed by the server from criteria
    criteria: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_ARRAY)
    missing_concepts: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_ARRAY)
    improvements: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_ARRAY)
    communication: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    follow_up_proposed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=sql("false"))
    follow_up_question: Mapped[OptStr]
    segment_ids: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=_EMPTY_ARRAY)
    error: Mapped[OptStr]
    created_at: Mapped[CreatedAt]
