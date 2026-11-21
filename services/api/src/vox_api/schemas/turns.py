"""Playground conversation history (sessions and turns)."""

import datetime as dt
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt, StringConstraints

TurnText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=5000)]


class TurnIn(BaseModel):
    role: Literal["user", "assistant"]
    text: TurnText
    latency_ms: NonNegativeInt | None = None
    stt_ms: NonNegativeInt | None = None
    first_token_ms: NonNegativeInt | None = None
    total_llm_ms: NonNegativeInt | None = None
    tts_start_ms: NonNegativeInt | None = None


class TurnsIn(BaseModel):
    mode: Literal["gemini", "browser"] = "browser"
    turns: list[TurnIn] = Field(max_length=200)


class Turn(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    session_id: str
    role: str
    text: str
    latency_ms: int | None
    stt_ms: int | None
    first_token_ms: int | None
    total_llm_ms: int | None
    tts_start_ms: int | None
    created_at: dt.datetime


class SessionTurns(BaseModel):
    session_id: str
    turns: list[Turn]


class AllTurns(BaseModel):
    sessions: list[str]
    turns: list[Turn]
