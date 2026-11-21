"""One interview turn as SSE (port of apps/web /api/chat interview mode).

meta → (done{budget_exceeded} | sentence/token… → tool… → done) or error. Uses its
own DB session: the stream outlives the request's session. Tool writes (answers,
agent steps, status) and the metered usage are committed when the turn ends,
including when the listener disconnects mid-turn.
"""

import random
import time
import uuid
from collections.abc import AsyncGenerator, Sequence
from contextlib import aclosing

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from vox_api.agent import loop
from vox_api.agent.tools.base import ToolContext
from vox_api.core.config import Settings
from vox_api.core.languages import language_directive
from vox_api.llm.base import LLMProvider, Message
from vox_api.models import UserMemory
from vox_api.prompts.interviewer import INTERVIEWER_SYSTEM_PROMPT
from vox_api.repositories import interviews as interviews_repo
from vox_api.services import cost_guard
from vox_api.services.chat import sse

log = structlog.get_logger("vox_api.agent_turn")
PROBLEM = "The interviewer hit a problem. Please try again."


async def _system_prompt(db: AsyncSession, user_id: uuid.UUID, language: str) -> str:
    prompt = INTERVIEWER_SYSTEM_PROMPT + language_directive(language)
    weak = (
        await db.scalars(
            select(UserMemory.text)
            .where(UserMemory.user_id == user_id, UserMemory.kind == "weakness")
            .order_by(UserMemory.created_at.desc())
            .limit(5)
        )
    ).all()
    if weak:
        prompt += (
            "\n\nThis candidate's known weak areas from past interviews (drill these first — "
            "pass them as focus_topics to get_question, one topic per call):\n"
            + "\n".join(f"- {w}" for w in weak)
        )
    return prompt


async def turn_events(
    session_factory: async_sessionmaker[AsyncSession],
    llm: LLMProvider | None,
    settings: Settings,
    user_id: uuid.UUID,
    interview_id: uuid.UUID,
    user_text: str,
    history: Sequence[Message],
    rng: random.Random | None = None,
) -> AsyncGenerator[bytes]:
    started = time.monotonic()

    def elapsed_ms() -> int:
        return round((time.monotonic() - started) * 1000)

    async with session_factory() as db:
        interview = await interviews_repo.get_owned(db, user_id, interview_id)
        if interview is None:  # checked by the endpoint; deleted since
            yield sse("error", {"message": PROBLEM})
            return
        system = await _system_prompt(db, user_id, interview.language)
        model = getattr(llm, "model", settings.gemini_model)
        yield sse(
            "meta",
            {
                "engine": "gemini",
                "model": model,
                "mode": "interview",
                "interview_id": str(interview_id),
                "first_token_ms": elapsed_ms(),
            },
        )
        budget = await cost_guard.check(db, user_id, settings.daily_token_budget)
        if not budget.allowed:
            yield sse("done", {"total_llm_ms": 0, "budget_exceeded": True, "message": budget.message})
            return
        if llm is None:
            log.error("agent_turn_no_model")
            yield sse("error", {"message": PROBLEM})
            return

        ctx = ToolContext(db=db, llm=llm, user_id=user_id, interview=interview, rng=rng or random.Random())  # noqa: S311 - question variety, not security
        result = loop.LoopResult()
        try:
            async with aclosing(loop.run(ctx, history, user_text, system, result)) as events:
                async for kind, text in events:
                    yield sse(kind, {"text": text})
            for step in result.steps:
                yield sse(
                    "tool", {"name": step.tool_name, "step": step.step_index, "duration_ms": step.duration_ms}
                )
            yield sse(
                "done",
                {
                    "total_llm_ms": elapsed_ms(),
                    "interview_id": str(interview_id),
                    "tool_steps": len(result.steps),
                    "hit_step_limit": result.hit_step_limit,
                    "tokens_in": result.tokens_in,
                    "tokens_out": result.tokens_out,
                },
            )
        except Exception as exc:  # any failure: one error event, never a broken stream
            log.error("agent_turn_failed", error_type=type(exc).__name__)
            yield sse("error", {"message": PROBLEM})
        finally:
            await cost_guard.record(
                db,
                user_id,
                result.tokens_in + ctx.usage.tokens_in,
                result.tokens_out + ctx.usage.tokens_out,
                settings.daily_token_budget,
            )
            await db.commit()
