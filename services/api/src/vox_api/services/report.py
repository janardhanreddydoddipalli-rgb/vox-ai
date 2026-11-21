"""Interview report generation (port of apps/web agent/report.ts)."""

import json
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from vox_api.core.languages import language_name
from vox_api.llm.base import Generation, LLMError, LLMProvider, Message
from vox_api.models import Interview, InterviewQa

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "overall": {"type": "number"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "gaps": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
        "perQuestion": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "score": {"type": "number"},
                    "better_answer": {"type": "string"},
                },
                "required": ["question", "score", "better_answer"],
            },
        },
    },
    "required": ["overall", "strengths", "gaps", "summary", "perQuestion"],
}


class PerQuestion(BaseModel):
    question: str
    score: float = Field(ge=0, le=10)
    better_answer: str


class Report(BaseModel):
    """Stored as-is in interviews.report (JSON keys match apps/web, incl. perQuestion)."""

    overall: float = Field(ge=0, le=10)
    strengths: list[str]
    gaps: list[str]
    summary: str
    perQuestion: list[PerQuestion] = Field(default_factory=list)  # noqa: N815 - stored JSON key


EMPTY_REPORT = Report(
    overall=0,
    strengths=[],
    gaps=["No answers were recorded."],
    summary="The interview ended before any answers were given.",
)


def transcript(qa: list[InterviewQa]) -> str:
    return "\n\n".join(
        f"Q{q.order + 1}: {q.question_text}\nA: {q.answer_text}\nEvaluation: "
        + json.dumps(q.evaluation or {}, separators=(",", ":"), ensure_ascii=False)
        for q in qa
    )


async def generate(
    llm: LLMProvider | None, interview: Interview, qa: list[InterviewQa]
) -> tuple[Report, Generation | None]:
    """The report and the generation that produced it (None when there was nothing to grade)."""
    if not qa:
        return EMPTY_REPORT, None
    if llm is None:
        raise LLMError("No model is configured")
    prompt = (
        "Write an interview report from this transcript. For EVERY question include a better_answer: "
        "a model spoken-style answer (3-6 short sentences) that would have scored 10. "
        "overall = average of the per-answer scores rounded to one decimal.\n"
        f"Write every field of the report in {language_name(interview.language)} "
        "(keep technical terms in English where that is the industry norm).\n\n" + transcript(qa)
    )
    gen = await llm.generate([Message("user", prompt)], response_schema=RESPONSE_SCHEMA, temperature=0.4)
    try:
        return Report.model_validate_json(gen.text), gen
    except ValidationError as exc:
        raise LLMError("Gemini returned a malformed report") from exc
