"""Interviews, reports, dashboard data and account deletion."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

Level = Literal["junior", "mid", "senior"]
Language = Literal["en", "hi", "ta", "te"]


class InterviewCreated(BaseModel):
    id: uuid.UUID


class InterviewSummary(BaseModel):
    id: uuid.UUID
    role: str
    level: str
    status: str
    language: str
    overall: float | None
    created_at: dt.datetime


class InterviewList(BaseModel):
    interviews: list[InterviewSummary]


class ScorePoint(BaseModel):
    interview_id: uuid.UUID
    order: int
    score: float | None
    created_at: dt.datetime


class ScoreList(BaseModel):
    scores: list[ScorePoint]


class QaItem(BaseModel):
    id: uuid.UUID
    order: int
    question_id: str | None
    question: str
    answer: str
    evaluation: dict[str, Any] | None
    created_at: dt.datetime


class InterviewDetail(BaseModel):
    id: uuid.UUID
    role: str
    level: str
    status: str
    language: str
    has_resume: bool
    current_question_index: int
    created_at: dt.datetime
    completed_at: dt.datetime | None
    report: dict[str, Any] | None
    qa: list[QaItem]


class EndResult(BaseModel):
    id: uuid.UUID
    report: dict[str, Any]


class AgentStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    step_index: int
    tool_name: str
    input: dict[str, Any]
    output: dict[str, Any]
    duration_ms: int
    created_at: dt.datetime


class AgentSteps(BaseModel):
    steps: list[AgentStepOut]


class SessionSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    mode: str
    created_at: dt.datetime


class SessionList(BaseModel):
    sessions: list[SessionSummary]


class DeletedAccount(BaseModel):
    sessions_deleted: int
