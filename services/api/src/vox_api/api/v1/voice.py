"""Live voice: start a session, run its tool calls, record its usage."""

import datetime as dt
import uuid
from typing import Any

import structlog
from fastapi import APIRouter, Depends

from vox_api.agent.tools.registry import tool_specs
from vox_api.api.deps import CurrentUser, DbSession, LiveTokensDep, LLMDep, SettingsDep, rate_limited
from vox_api.core.errors import ProblemError
from vox_api.llm.base import LLMError
from vox_api.llm.live import TOKEN_LIFETIME
from vox_api.repositories import interviews as interviews_repo
from vox_api.repositories import voice as voice_repo
from vox_api.schemas.voice import (
    FunctionDeclaration,
    ToolCallIn,
    ToolCallOut,
    UsageIn,
    UsageOut,
    VoiceSessionIn,
    VoiceSessionOut,
)
from vox_api.services import cost_guard, voice

router = APIRouter(prefix="/voice", tags=["voice"])
log = structlog.get_logger("vox_api.voice")

NOT_FOUND = "Voice session not found"
NOT_CONFIGURED = "Voice service is not configured"
RESPONSES_404: dict[int | str, dict[str, Any]] = {
    404: {"description": "Not found, or not yours (problem+json)"}
}


@router.post(
    "/sessions",
    status_code=201,
    summary="Start a live voice session: an ephemeral Gemini Live token plus its setup",
    responses={
        **RESPONSES_404,
        429: {"description": "Rate limited, or code=budget_exceeded"},
        502: {"description": "Gemini refused the token"},
        503: {"description": "No Gemini key configured"},
    },
    dependencies=[Depends(rate_limited("voice-session", limit=10))],
)
async def create_session(
    body: VoiceSessionIn, user: CurrentUser, db: DbSession, settings: SettingsDep, live: LiveTokensDep
) -> VoiceSessionOut:
    interview = None
    if body.interview_id is not None:
        interview = await interviews_repo.get_owned(db, user.id, body.interview_id)
        if interview is None:
            raise ProblemError(404, "Interview not found")
    budget = await cost_guard.check(db, user.id, settings.daily_token_budget)
    if not budget.allowed:
        raise ProblemError(429, budget.message, code="budget_exceeded")
    if live is None:
        raise ProblemError(503, NOT_CONFIGURED)
    try:
        token = await live.mint()
    except LLMError as exc:
        log.warning("live_token_mint_failed", error=str(exc))
        raise ProblemError(502, "Could not start live voice") from exc

    session = await voice_repo.create_session(
        db, user.id, body.interview_id, dt.datetime.now(dt.UTC) + voice.SESSION_TTL
    )
    language = body.language or (interview.language if interview is not None else None)
    return VoiceSessionOut(
        session_id=session.id,
        token=token,
        model=settings.gemini_live_model,
        system_instruction=voice.system_instruction(language),
        tools=[
            FunctionDeclaration(name=s.name, description=s.description, parameters=s.parameters)
            for s in tool_specs()
        ],
        expires_in_sec=int(TOKEN_LIFETIME.total_seconds()),
    )


@router.post(
    "/sessions/{session_id}/tool-calls",
    summary="Run one tool call from a live session (idempotent per call_id)",
    responses={
        **RESPONSES_404,
        409: {"description": "call_id was already used for another tool"},
        410: {"description": "Voice session expired"},
        503: {"description": "No model configured"},
    },
    dependencies=[Depends(rate_limited("voice-tool", limit=120))],
)
async def tool_call(
    session_id: uuid.UUID,
    body: ToolCallIn,
    user: CurrentUser,
    db: DbSession,
    llm: LLMDep,
    settings: SettingsDep,
) -> ToolCallOut:
    session = await voice_repo.get_owned(db, user.id, session_id, lock=True)
    if session is None:
        raise ProblemError(404, NOT_FOUND)
    done = await voice_repo.get_call(db, session.id, body.call_id)
    if done is not None:
        if done.tool_name != body.name:
            raise ProblemError(409, "call_id was already used for another tool")
        return ToolCallOut(ok=True, result=done.output)
    if session.expires_at <= dt.datetime.now(dt.UTC):
        raise ProblemError(410, "Voice session expired")
    if llm is None:
        raise ProblemError(503, NOT_CONFIGURED)
    budget = await cost_guard.check(db, user.id, settings.daily_token_budget)
    if not budget.allowed:
        return ToolCallOut(ok=False, error="budget_exceeded", message=budget.message)

    outcome = await voice.run_tool_call(db, llm, settings, session, body.call_id, body.name, body.args)
    if not outcome.ok:
        return ToolCallOut(ok=False, error=str(outcome.output.get("error", "tool failed")))
    return ToolCallOut(ok=True, result=outcome.output)


@router.post(
    "/sessions/{session_id}/usage",
    summary="Record a live session's token usage against the daily budget",
    responses=RESPONSES_404,
    dependencies=[Depends(rate_limited("voice-usage", limit=120))],
)
async def record_usage(
    session_id: uuid.UUID, body: UsageIn, user: CurrentUser, db: DbSession, settings: SettingsDep
) -> UsageOut:
    """Counts are client-reported, so they are bounded per report and kept per session
    for reconciliation. An expired session still records: the spend was real."""
    session = await voice_repo.get_owned(db, user.id, session_id)
    if session is None:
        raise ProblemError(404, NOT_FOUND)
    await voice_repo.add_tokens(db, session.id, body.prompt_tokens, body.response_tokens)
    await cost_guard.record(
        db, user.id, body.prompt_tokens, body.response_tokens, settings.daily_token_budget
    )
    budget = await cost_guard.check(db, user.id, settings.daily_token_budget)
    return UsageOut(budget_exceeded=not budget.allowed, message=budget.message)
