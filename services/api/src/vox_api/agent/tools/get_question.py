"""get_question: the next question from the bank (or the résumé), never one already asked."""

import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import select

from vox_api.agent.tools.base import Tool, ToolContext
from vox_api.agent.tools.common import interview_resume, resume_question_text
from vox_api.models import Question

_CATEGORY_RULES = [
    ("frontend", r"front|react|ui|web|css"),
    ("backend", r"back|api|server|node|python|java|database"),
    ("dsa", r"dsa|algorithm|data structure|coding"),
    ("hr", r"hr|behavior|general"),
]


class GetQuestionIn(BaseModel):
    role: Annotated[str, StringConstraints(min_length=1, max_length=80)]
    level: Literal["junior", "mid", "senior"]
    # Bank ids are UUIDs, résumé questions are "resume:<id>:<n>"; both may be listed.
    asked_ids: list[Annotated[str, StringConstraints(max_length=100)]] = Field(
        default_factory=list, max_length=100
    )
    use_resume: bool = False
    focus_topics: list[Annotated[str, StringConstraints(min_length=1, max_length=120)]] = Field(
        default_factory=list, max_length=10
    )


async def handler(args: GetQuestionIn, ctx: ToolContext) -> dict[str, Any]:
    if args.use_resume and ctx.interview is not None:
        resume = await interview_resume(ctx)
        if resume is not None and resume.projects:
            n = len(args.asked_ids)
            project = resume.projects[n % len(resume.projects)]
            return {
                "question_id": f"resume:{resume.id}:{n}",
                "category": "resume",
                "question": resume_question_text(project),
                "source": "resume",
                "level": args.level,
            }

    bank = (await ctx.db.scalars(select(Question).order_by(Question.id))).all()
    role = args.role.lower()
    categories = {cat for cat, pattern in _CATEGORY_RULES if re.search(pattern, role)}
    pool = [q for q in bank if not categories or q.category in categories]
    fresh = [q for q in pool if str(q.id) not in args.asked_ids]
    source = fresh or pool  # everything asked: reuse
    if not source:
        return {"question": None, "message": "The question bank is empty."}

    if args.focus_topics:
        focus = [t.lower() for t in args.focus_topics]

        def matches(q: Question) -> bool:
            hay = f"{q.category} {q.text}".lower()
            return any(t in hay or any(len(w) > 3 and w in hay for w in t.split()) for t in focus)

        weak = [q for q in source if matches(q)]
        # 70% of the time drill a known weakness when a matching question exists.
        candidates = weak if weak and ctx.rng.random() < 0.7 else source
    else:
        candidates = source
    picked = ctx.rng.choice(candidates)
    return {
        "question_id": str(picked.id),
        "category": picked.category,
        "question": picked.text,
        "level": args.level,
    }


TOOL = Tool(
    name="get_question",
    description=(
        "Get the next interview question for a role and seniority level. Pass the ids of questions already "
        "asked in this interview so the same question never repeats. Set use_resume to true to ask about "
        "the candidate's résumé (projects, experience)."
    ),
    input_model=GetQuestionIn,
    handler=handler,
)
