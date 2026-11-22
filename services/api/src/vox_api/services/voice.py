"""Live voice: the system prompt a session opens with, and the tool bridge.

The browser talks to Gemini Live directly. Tool calls and usage come back to the
API keyed by the server-issued session id, which fixes the user and the
interview: the browser never names the interview a tool acts on.
"""

import datetime as dt
import time
from typing import Any

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.agent import loop
from vox_api.agent.tools.base import ToolContext
from vox_api.core.config import Settings
from vox_api.core.languages import language_directive
from vox_api.llm.base import LLMProvider
from vox_api.models import AgentStep, VoiceSession
from vox_api.prompts.interviewer import INTERVIEWER_SYSTEM_PROMPT
from vox_api.repositories import interviews as interviews_repo
from vox_api.repositories import voice as voice_repo
from vox_api.services import cost_guard

log = structlog.get_logger("vox_api.voice")

# Tool calls are accepted for this long. A Live session ends well before, and a
# reconnect starts a new voice session.
SESSION_TTL = dt.timedelta(minutes=60)
LIVE_CALL_RULES = (
    "\n\nYou are on a live voice call: keep replies to one or two spoken sentences, never use lists, "
    "markdown or emoji, and spell out numbers and code naturally for speech."
)


def system_instruction(language: str | None) -> str:
    return INTERVIEWER_SYSTEM_PROMPT + (language_directive(language) if language else "") + LIVE_CALL_RULES


async def run_tool_call(
    db: AsyncSession,
    llm: LLMProvider,
    settings: Settings,
    session: VoiceSession,
    call_id: str,
    name: str,
    args: dict[str, Any],
) -> loop.ToolOutcome:
    """Run one tool on the session's own interview, meter it, trace it, and store the
    output under call_id so a retried call replays it. Failed calls are not stored."""
    interview = (
        await interviews_repo.get_owned(db, session.user_id, session.interview_id)
        if session.interview_id is not None
        else None
    )
    ctx = ToolContext(db=db, llm=llm, user_id=session.user_id, interview=interview)
    started = time.monotonic()
    outcome = await loop.execute_tool(name, args, ctx)
    await cost_guard.record(
        db, session.user_id, ctx.usage.tokens_in, ctx.usage.tokens_out, settings.daily_token_budget
    )
    if not outcome.ok:
        log.info("voice_tool_failed", tool=name)  # never args or output: they carry answer text
        return outcome
    if interview is not None:
        db.add(
            AgentStep(
                interview_id=interview.id,
                step_index=-1,  # live-session steps are ordered by created_at
                tool_name=name,
                input=args,
                output=outcome.output,
                duration_ms=round((time.monotonic() - started) * 1000),
            )
        )
    await voice_repo.save_call(db, session.id, call_id, name, outcome.output)
    return outcome
