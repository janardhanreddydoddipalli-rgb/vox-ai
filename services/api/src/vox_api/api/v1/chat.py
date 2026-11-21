"""POST /v1/chat: the voice playground's spoken replies as Server-Sent Events."""

from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, StringConstraints

from vox_api.api.deps import CurrentUser, LLMDep, SettingsDep, rate_limited
from vox_api.llm.base import Message
from vox_api.services import chat, cost_guard

router = APIRouter(tags=["chat"])


class HistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    text: Annotated[str, StringConstraints(max_length=2000)]


class ChatIn(BaseModel):
    user_text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    history: list[HistoryTurn] = Field(default_factory=list, max_length=20)


@router.post(
    "/chat",
    summary="Stream a spoken reply (SSE: meta, token, sentence, done | error)",
    response_class=StreamingResponse,
    responses={200: {"content": {"text/event-stream": {}}}, 429: {"description": "Rate limited"}},
    dependencies=[Depends(rate_limited("chat", limit=30))],
)
async def chat_stream(
    body: ChatIn, request: Request, user: CurrentUser, llm: LLMDep, settings: SettingsDep
) -> StreamingResponse:
    history = [Message("model" if t.role == "assistant" else "user", t.text) for t in body.history]
    usage = chat.Usage()
    user_id = user.id

    async def events() -> AsyncIterator[bytes]:
        try:
            async for event in chat.chat_events(llm, body.user_text, history, usage):
                yield event
        finally:
            # A fresh session: the request's session may be closed while the stream runs.
            async with request.app.state.session_factory() as db:
                await cost_guard.record(
                    db, user_id, usage.tokens_in, usage.tokens_out, settings.daily_token_budget
                )
                await db.commit()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
