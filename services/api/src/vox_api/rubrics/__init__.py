"""Versioned evaluation rubrics, one per round type.

A released version is immutable: change a rubric by adding a new version and
pointing CURRENT at it (tests pin a fingerprint of every released version).
Evaluations store the version they were scored with, so old results stay
explainable. Criteria score technical substance only. Communication feedback
is optional, separate, and never part of the score, and nothing here (or in the
evaluator) may use accent, pitch or speaking speed.
"""

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Literal

Level = Literal["junior", "mid", "senior"]
RoundType = Literal["screening", "technical", "project", "behavioral", "managerial"]
ROUND_TYPES: tuple[RoundType, ...] = ("screening", "technical", "project", "behavioral", "managerial")

SCALE_MAX = 4  # criterion scores are 0..4; a question's score is the weighted mean scaled to 0..10


@dataclass(frozen=True)
class Criterion:
    id: str
    title: str
    description: str
    weight: float
    expectations: dict[Level, str]


@dataclass(frozen=True)
class Rubric:
    version: str
    round_type: RoundType
    criteria: tuple[Criterion, ...]

    def criterion_ids(self) -> list[str]:
        return [c.id for c in self.criteria]

    def fingerprint(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True).encode()).hexdigest()[:16]


def _c(
    cid: str, title: str, description: str, weight: float, junior: str, mid: str, senior: str
) -> Criterion:
    return Criterion(cid, title, description, weight, {"junior": junior, "mid": mid, "senior": senior})


_RUBRICS: tuple[Rubric, ...] = (
    Rubric(
        "screening-v1",
        "screening",
        (
            _c(
                "role_understanding",
                "Role understanding",
                "Knows what the role involves and why they fit it.",
                0.5,
                "Names the core duties of the role.",
                "Connects their experience to the role's duties.",
                "Explains the role's impact and trade-offs, and where they would add most.",
            ),
            _c(
                "relevant_experience",
                "Relevant experience",
                "Gives concrete, relevant examples of past work.",
                0.5,
                "Mentions coursework or projects that relate.",
                "Describes specific work with their own contribution.",
                "Describes ownership of outcomes with scope and results.",
            ),
        ),
    ),
    Rubric(
        "technical-v1",
        "technical",
        (
            _c(
                "correctness",
                "Correctness",
                "What is stated is technically right.",
                0.4,
                "The main idea is right, minor slips allowed.",
                "Right, including the important details.",
                "Right, precise, and edge cases are handled.",
            ),
            _c(
                "depth",
                "Depth",
                "Goes beyond definitions into how and why.",
                0.35,
                "Explains what it is and one reason it matters.",
                "Explains how it works and when to use it.",
                "Explains internals, trade-offs and failure modes.",
            ),
            _c(
                "application",
                "Application",
                "Relates the concept to real use: examples, trade-offs, decisions.",
                0.25,
                "Gives one example.",
                "Gives a realistic example and a trade-off.",
                "Compares alternatives and justifies a choice for a context.",
            ),
        ),
    ),
    Rubric(
        "project-v1",
        "project",
        (
            _c(
                "ownership",
                "Ownership",
                "Their own role and decisions are clear.",
                0.35,
                "Says what they built.",
                "Says what they decided and why.",
                "Says what they owned end to end, including what they would change.",
            ),
            _c(
                "technical_decisions",
                "Technical decisions",
                "Explains design choices and alternatives considered.",
                0.4,
                "Names the main technologies used.",
                "Explains why those were chosen.",
                "Explains alternatives, trade-offs and how the choice held up.",
            ),
            _c(
                "impact",
                "Impact",
                "Results, measured where possible.",
                0.25,
                "Says what the project achieved.",
                "Gives a concrete result.",
                "Gives measured results and what they learned.",
            ),
        ),
    ),
    Rubric(
        "behavioral-v1",
        "behavioral",
        (
            _c(
                "situation_action",
                "Situation and action",
                "A specific situation and what they personally did.",
                0.5,
                "Describes a real situation.",
                "Describes the situation and their own actions clearly.",
                "Describes a complex situation and deliberate, well-reasoned actions.",
            ),
            _c(
                "result_reflection",
                "Result and reflection",
                "The outcome and what they learned.",
                0.5,
                "States the outcome.",
                "States the outcome and a lesson.",
                "States the outcome, the lesson and how it changed later behaviour.",
            ),
        ),
    ),
    Rubric(
        "managerial-v1",
        "managerial",
        (
            _c(
                "people",
                "People",
                "Supports, aligns and develops the people involved.",
                0.4,
                "Mentions working with others.",
                "Describes how they supported or aligned a team.",
                "Describes developing people and resolving conflict with care.",
            ),
            _c(
                "prioritisation",
                "Prioritisation",
                "Makes and explains trade-offs between competing goals.",
                0.35,
                "Names competing priorities.",
                "Explains how they chose between them.",
                "Explains a principled framework and its consequences.",
            ),
            _c(
                "accountability",
                "Accountability",
                "Owns outcomes, including failures.",
                0.25,
                "Acknowledges the outcome.",
                "Takes responsibility and describes a fix.",
                "Takes responsibility, fixes the cause and prevents a repeat.",
            ),
        ),
    ),
)

RUBRICS: dict[str, Rubric] = {r.version: r for r in _RUBRICS}
CURRENT: dict[RoundType, str] = {
    "screening": "screening-v1",
    "technical": "technical-v1",
    "project": "project-v1",
    "behavioral": "behavioral-v1",
    "managerial": "managerial-v1",
}


def get(version: str) -> Rubric:
    try:
        return RUBRICS[version]
    except KeyError as exc:
        raise KeyError(f"Unknown rubric version: {version}") from exc


@dataclass(frozen=True)
class RoundDefaults:
    question_count: int
    duration_minutes: int
    follow_up_depth: int


ROUND_DEFAULTS: dict[RoundType, RoundDefaults] = {
    "screening": RoundDefaults(2, 10, 0),
    "technical": RoundDefaults(3, 20, 1),
    "project": RoundDefaults(2, 20, 2),
    "behavioral": RoundDefaults(2, 15, 1),
    "managerial": RoundDefaults(2, 15, 1),
}
