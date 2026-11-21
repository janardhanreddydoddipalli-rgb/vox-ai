"""evaluate_answer: a structured score for the candidate's answer, saved for the report."""

from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints, ValidationError
from sqlalchemy import select

from vox_api.agent.tools.base import Tool, ToolContext
from vox_api.agent.tools.common import (
    append_qa,
    interview_resume,
    is_uuid,
    resume_question_index,
    resume_question_text,
)
from vox_api.llm.base import LLMError, Message
from vox_api.models import Question

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "score": {"type": "integer"},
        "clarity": {"type": "string"},
        "depth": {"type": "string"},
        "correctness": {"type": "string"},
        "missing_points": {"type": "array", "items": {"type": "string"}},
        "follow_up_needed": {"type": "boolean"},
        "follow_up_question": {"type": "string", "nullable": True},
    },
    "required": ["score", "clarity", "depth", "correctness", "missing_points", "follow_up_needed"],
}


class EvaluateIn(BaseModel):
    # A bank question's UUID, or "resume:<id>:<n>" for a résumé question. (The web
    # version accepted only UUIDs, so résumé answers could never be evaluated.)
    question_id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    answer_text: Annotated[str, StringConstraints(min_length=1, max_length=4000)]


class Evaluation(BaseModel):
    score: int = Field(ge=1, le=10)
    clarity: str
    depth: str
    correctness: str
    missing_points: list[str]
    follow_up_needed: bool
    follow_up_question: str | None = None


async def _question_text(args: EvaluateIn, ctx: ToolContext) -> str | None:
    index = resume_question_index(args.question_id)
    if index is not None:
        resume = await interview_resume(ctx)
        if resume is None or not resume.projects:
            return "Résumé project question"
        project = resume.projects[index % len(resume.projects)]
        return resume_question_text(project)
    if not is_uuid(args.question_id):
        return None
    question = await ctx.db.scalar(select(Question).where(Question.id == args.question_id))
    return question.text if question else None


async def handler(args: EvaluateIn, ctx: ToolContext) -> dict[str, Any]:
    question_text = await _question_text(args, ctx)
    if question_text is None:
        return {"error": f"Unknown question_id: {args.question_id}"}
    prompt = (
        f"Interview question: {question_text}\n\nCandidate answer: {args.answer_text}\n\n"
        "Evaluate this answer as a rigorous but fair interviewer. Grade the answer 1-10, "
        "and assess clarity, depth and correctness in one spoken-style sentence each. "
        "List the concrete points the answer missed. Decide if a follow-up question is needed."
    )
    gen = await ctx.llm.generate([Message("user", prompt)], response_schema=RESPONSE_SCHEMA, temperature=0.3)
    ctx.usage.tokens_in += gen.tokens_in
    ctx.usage.tokens_out += gen.tokens_out
    try:
        evaluation = Evaluation.model_validate_json(gen.text).model_dump(exclude_none=True)
    except ValidationError as exc:
        raise LLMError("Gemini evaluation returned malformed JSON") from exc
    bank_id = None if resume_question_index(args.question_id) is not None else args.question_id
    await append_qa(ctx, bank_id, question_text, args.answer_text, evaluation)
    return evaluation


TOOL = Tool(
    name="evaluate_answer",
    description=(
        "Evaluate the candidate's answer to the current question. Returns a structured score out of 10, "
        "clarity/depth/correctness notes, missing points, and whether a follow-up question is needed. "
        "Use its follow_up_question when follow_up_needed is true."
    ),
    input_model=EvaluateIn,
    handler=handler,
)
