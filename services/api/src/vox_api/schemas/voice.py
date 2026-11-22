"""Live voice: session config for the browser, the tool bridge and usage reports."""

import uuid
from typing import Annotated, Any

from pydantic import BaseModel, Field, StringConstraints

from vox_api.schemas.interviews import Language

# Far above one live turn, low enough that one forged report can't poison the ledger.
MAX_TOKENS_PER_REPORT = 1_000_000


class VoiceSessionIn(BaseModel):
    interview_id: uuid.UUID | None = None
    # Defaults to the interview's language when an interview is given.
    language: Language | None = None


class FunctionDeclaration(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any]


class VoiceSessionOut(BaseModel):
    session_id: uuid.UUID
    token: str
    model: str
    system_instruction: str
    tools: list[FunctionDeclaration]
    expires_in_sec: int


class ToolCallIn(BaseModel):
    # Gemini's functionCall id: a retry with the same id returns the stored output.
    call_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    name: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    args: dict[str, Any] = Field(default_factory=dict)


class ToolCallOut(BaseModel):
    ok: bool
    result: dict[str, Any] | None = None
    error: str | None = None
    message: str | None = None


class UsageIn(BaseModel):
    prompt_tokens: int = Field(ge=0, le=MAX_TOKENS_PER_REPORT)
    response_tokens: int = Field(ge=0, le=MAX_TOKENS_PER_REPORT)


class UsageOut(BaseModel):
    budget_exceeded: bool
    message: str | None = None
