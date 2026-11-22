"""Evidence-backed scoring of one answer against a versioned rubric.

The model proposes per-criterion scores with quotes; the server accepts them only
if every quote is copied from a persisted candidate segment for this question.
The server computes the score itself (the weighted mean of criterion scores,
scaled to 0..10), so the model cannot assert one. An answer too short to judge
abstains without a model call; an output that stays invalid after the retry is
reported as invalid rather than guessed.

A verified quote proves the words were said, not that the score is right: that
is what calibration against human reviewers measures (evals/calibration).
"""

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

from vox_api.llm.base import LLMProvider, Message
from vox_api.prompts.evaluator import EVALUATOR_PROMPT_VERSION, EVALUATOR_SYSTEM_PROMPT
from vox_api.rubrics import SCALE_MAX, Level, Rubric

MAX_ATTEMPTS = 2  # one retry after an invalid output, with the problems fed back
MIN_ANSWER_WORDS = 5  # fewer candidate words than this: abstain without asking the model
MIN_QUOTE_WORDS = 3  # shorter quotes can't carry a judgement

_TOO_LITTLE = "Give a fuller answer: there was too little to evaluate."
_FULLER = "Give a fuller answer that addresses the question."

Status = Literal["scored", "insufficient_evidence", "invalid"]

RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "insufficient_evidence": {"type": "boolean"},
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "criterion_id": {"type": "string"},
                    "score": {"type": "integer"},
                    "rationale": {"type": "string"},
                    "evidence": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"segment_id": {"type": "string"}, "quote": {"type": "string"}},
                            "required": ["segment_id", "quote"],
                        },
                    },
                },
                "required": ["criterion_id", "score", "rationale", "evidence"],
            },
        },
        "missing_concepts": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
        "follow_up_needed": {"type": "boolean"},
        "follow_up_question": {"type": "string", "nullable": True},
        "communication_notes": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["insufficient_evidence", "criteria", "missing_concepts", "improvements", "follow_up_needed"],
}


@dataclass(frozen=True)
class Segment:
    id: str
    text: str


class _Quote(BaseModel):
    segment_id: str
    quote: str


class _Criterion(BaseModel):
    criterion_id: str
    score: int
    rationale: str = ""
    evidence: list[_Quote] = Field(default_factory=list)


class _Output(BaseModel):
    insufficient_evidence: bool
    criteria: list[_Criterion] = Field(default_factory=list)
    missing_concepts: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    follow_up_needed: bool = False
    follow_up_question: str | None = None
    communication_notes: list[str] = Field(default_factory=list)


@dataclass
class Outcome:
    status: Status
    rubric_version: str
    prompt_version: str = EVALUATOR_PROMPT_VERSION
    model: str = "none"
    score: float | None = None
    criteria: list[dict[str, Any]] = field(default_factory=list)
    missing_concepts: list[str] = field(default_factory=list)
    improvements: list[str] = field(default_factory=list)
    communication: dict[str, Any] | None = None
    follow_up_proposed: bool = False
    follow_up_question: str | None = None
    problems: list[str] = field(default_factory=list)
    attempts: int = 0
    tokens_in: int = 0
    tokens_out: int = 0


# Curly quotes typed or transcribed as straight ones (by code point, so the source stays ASCII).
_QUOTES = str.maketrans({0x2018: "'", 0x2019: "'", 0x201C: '"', 0x201D: '"'})


def _norm(text: str) -> str:
    text = text.translate(_QUOTES)
    return re.sub(r"\s+", " ", text).strip().casefold()


def _words(text: str) -> int:
    return len(re.findall(r"\w+", text))


def score_from(rubric: Rubric, criterion_scores: dict[str, int]) -> float:
    """The server's score: weighted criterion scores, scaled to 0..10 (one decimal)."""
    total = sum(c.weight * criterion_scores[c.id] / SCALE_MAX for c in rubric.criteria)
    return round(total * 10, 1)


def validate(
    raw: str, rubric: Rubric, question: str, segments: Sequence[Segment]
) -> tuple[_Output | None, list[str]]:
    """The parsed output and the problems that make it unacceptable (none = accept)."""
    try:
        out = _Output.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError) as exc:
        return None, [f"output is not valid JSON for the schema ({type(exc).__name__})"]
    if out.insufficient_evidence:
        return out, []

    problems: list[str] = []
    by_id = {s.id: _norm(s.text) for s in segments}
    question_n = _norm(question)
    seen = [c.criterion_id for c in out.criteria]
    if sorted(seen) != sorted(rubric.criterion_ids()):
        problems.append(f"criteria must be exactly {rubric.criterion_ids()}, got {seen}")
    for c in out.criteria:
        if not 0 <= c.score <= SCALE_MAX:
            problems.append(f"{c.criterion_id}: score {c.score} is outside 0..{SCALE_MAX}")
        if c.score > 0 and not c.evidence:
            problems.append(f"{c.criterion_id}: a score above 0 needs at least one quote")
        for q in c.evidence:
            quote = _norm(q.quote)
            source = by_id.get(q.segment_id)
            if source is None:
                problems.append(f"{c.criterion_id}: segment {q.segment_id!r} is not one of the candidate's")
            elif quote not in source:
                problems.append(
                    f"{c.criterion_id}: quote not found in segment {q.segment_id}: {q.quote[:60]!r}"
                )
            elif _words(quote) < MIN_QUOTE_WORDS:
                problems.append(f"{c.criterion_id}: quote is too short to be evidence: {q.quote!r}")
            elif quote in question_n:
                problems.append(f"{c.criterion_id}: quote only repeats the question: {q.quote!r}")
    if out.follow_up_needed and not (out.follow_up_question or "").strip():
        problems.append("follow_up_needed is true but follow_up_question is empty")
    return out, problems


def _prompt(
    rubric: Rubric, level: Level, question: str, segments: Sequence[Segment], problems: list[str]
) -> str:
    criteria = "\n".join(
        f"- {c.id} (weight {c.weight}): {c.description} Expected at {level}: {c.expectations[level]}"
        for c in rubric.criteria
    )
    answer = "\n".join(f"[{s.id}] {s.text}" for s in segments)
    retry = (
        "\n\nYour previous output was rejected for these reasons; fix them:\n"
        + "\n".join(f"- {p}" for p in problems)
        if problems
        else ""
    )
    return (
        f"Rubric {rubric.version} ({rubric.round_type} round), candidate level: {level}.\n"
        f"Criteria:\n{criteria}\n\nQuestion: {question}\n\n"
        f"Candidate answer segments (quote these, with their ids):\n{answer}{retry}"
    )


async def evaluate(
    llm: LLMProvider, rubric: Rubric, level: Level, question: str, segments: Sequence[Segment]
) -> Outcome:
    """Evaluate the candidate's segments for one question. LLMError propagates (the caller records it)."""
    candidate = [s for s in segments if s.text.strip()]
    if sum(_words(s.text) for s in candidate) < MIN_ANSWER_WORDS:
        return Outcome(
            status="insufficient_evidence", rubric_version=rubric.version, improvements=[_TOO_LITTLE]
        )

    problems: list[str] = []
    outcome = Outcome(status="invalid", rubric_version=rubric.version)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        gen = await llm.generate(
            [Message("user", _prompt(rubric, level, question, candidate, problems))],
            system=EVALUATOR_SYSTEM_PROMPT,
            response_schema=RESPONSE_SCHEMA,
            temperature=0.2,
        )
        outcome.attempts = attempt
        outcome.model = gen.model or getattr(llm, "model", "unknown")
        outcome.tokens_in += gen.tokens_in
        outcome.tokens_out += gen.tokens_out
        parsed, problems = validate(gen.text, rubric, question, candidate)
        if parsed is None or problems:
            continue
        outcome.missing_concepts = parsed.missing_concepts
        outcome.follow_up_proposed = parsed.follow_up_needed
        outcome.follow_up_question = parsed.follow_up_question if parsed.follow_up_needed else None
        outcome.communication = {"notes": parsed.communication_notes} if parsed.communication_notes else None
        if parsed.insufficient_evidence:
            outcome.status = "insufficient_evidence"
            outcome.improvements = (parsed.improvements or [_FULLER])[:1]
            return outcome
        outcome.status = "scored"
        outcome.score = score_from(rubric, {c.criterion_id: c.score for c in parsed.criteria})
        outcome.criteria = [
            {
                "criterion_id": c.criterion_id,
                "score": c.score,
                "rationale": c.rationale,
                "evidence": [q.model_dump() for q in c.evidence],
            }
            for c in parsed.criteria
        ]
        outcome.improvements = parsed.improvements
        return outcome
    outcome.problems = problems
    return outcome
