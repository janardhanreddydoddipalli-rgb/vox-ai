"""Shared queries for the interview tools."""

import uuid
from typing import Any

from sqlalchemy import func, insert, select

from vox_api.agent.tools.base import ToolContext
from vox_api.models import Interview, InterviewQa, Resume


async def interview_resume(ctx: ToolContext) -> Resume | None:
    iv = ctx.interview
    if iv is None or iv.resume_id is None:
        return None
    return await ctx.db.scalar(select(Resume).where(Resume.id == iv.resume_id, Resume.user_id == ctx.user_id))


def resume_question_index(question_id: str) -> int | None:
    """resume:<resume id>:<n> → n."""
    parts = question_id.split(":")
    if len(parts) == 3 and parts[0] == "resume" and parts[2].isdigit():
        return int(parts[2])
    return None


async def append_qa(
    ctx: ToolContext,
    question_id: str | None,
    question_text: str,
    answer_text: str,
    evaluation: dict[str, Any],
) -> None:
    """Next order number under a row lock on the interview (concurrent saves serialise)."""
    iv = ctx.interview
    if iv is None:
        return
    await ctx.db.execute(select(Interview.id).where(Interview.id == iv.id).with_for_update())
    next_order = await ctx.db.scalar(
        select(func.coalesce(func.max(InterviewQa.order) + 1, 0)).where(InterviewQa.interview_id == iv.id)
    )
    await ctx.db.execute(
        insert(InterviewQa).values(
            interview_id=iv.id,
            order=int(next_order or 0),
            question_id=question_id,
            question_text=question_text,
            answer_text=answer_text,
            evaluation=evaluation,
        )
    )


def is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def resume_question_text(project: dict[str, Any]) -> str:
    """The spoken résumé question for a project (shared by get_question and evaluate_answer)."""
    return f"Tell me about your work on {project.get('name', '')}. {project.get('summary', '')}".strip()
