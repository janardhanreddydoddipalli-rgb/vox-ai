"""Interviews, résumés, answered questions and agent steps. Every read starts from the user."""

import datetime as dt
import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import AgentStep, Interview, InterviewQa, Resume, Session, User


async def create_resume(
    db: AsyncSession, user_id: uuid.UUID, filename: str, raw_text: str, structure: dict[str, Any]
) -> Resume:
    resume = Resume(user_id=user_id, filename=filename, raw_text=raw_text, **structure)
    db.add(resume)
    await db.flush()
    return resume


async def create(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    role: str,
    level: str,
    language: str,
    job_description: str | None,
    resume_id: uuid.UUID | None,
) -> Interview:
    interview = Interview(
        user_id=user_id,
        role=role,
        level=level,
        language=language,
        job_description=job_description,
        resume_id=resume_id,
    )
    db.add(interview)
    await db.flush()
    await db.refresh(interview)
    return interview


async def get_owned(db: AsyncSession, user_id: uuid.UUID, interview_id: uuid.UUID) -> Interview | None:
    """The interview only if it belongs to the user (otherwise None: callers answer 404)."""
    return await db.scalar(
        select(Interview).where(Interview.id == interview_id, Interview.user_id == user_id)
    )


async def list_for_user(db: AsyncSession, user_id: uuid.UUID, limit: int = 50) -> Sequence[Interview]:
    stmt = (
        select(Interview)
        .where(Interview.user_id == user_id)
        .order_by(Interview.created_at.desc())
        .limit(limit)
    )
    return (await db.scalars(stmt)).all()


async def qa_for(db: AsyncSession, interview_id: uuid.UUID) -> list[InterviewQa]:
    stmt = select(InterviewQa).where(InterviewQa.interview_id == interview_id).order_by(InterviewQa.order)
    return list((await db.scalars(stmt)).all())


async def scores_for_user(db: AsyncSession, user_id: uuid.UUID) -> Sequence[InterviewQa]:
    stmt = (
        select(InterviewQa)
        .join(Interview, InterviewQa.interview_id == Interview.id)
        .where(Interview.user_id == user_id)
        .order_by(InterviewQa.created_at)
    )
    return (await db.scalars(stmt)).all()


async def steps_for(db: AsyncSession, interview_id: uuid.UUID) -> Sequence[AgentStep]:
    stmt = (
        select(AgentStep)
        .where(AgentStep.interview_id == interview_id)
        .order_by(AgentStep.created_at, AgentStep.id)
    )
    return (await db.scalars(stmt)).all()


async def save_report(db: AsyncSession, interview: Interview, report: dict[str, Any]) -> None:
    interview.report = report
    interview.status = "complete"
    interview.completed_at = dt.datetime.now(dt.UTC)
    await db.flush()


async def sessions_for_user(db: AsyncSession, user_id: uuid.UUID) -> Sequence[Session]:
    stmt = select(Session).where(Session.user_id == user_id).order_by(Session.created_at.desc())
    return (await db.scalars(stmt)).all()


async def delete_user_and_data(db: AsyncSession, user_id: uuid.UUID) -> int:
    """Delete the user; FK cascades remove everything they own. Returns their session count."""
    sessions = int(
        await db.scalar(select(func.count()).select_from(Session).where(Session.user_id == user_id)) or 0
    )
    await db.execute(delete(User).where(User.id == user_id))
    return sessions
