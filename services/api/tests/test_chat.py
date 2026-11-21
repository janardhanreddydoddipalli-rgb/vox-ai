"""POST /v1/chat SSE (ported from apps/web tests/api-chat.test.ts)."""

import datetime as dt
import json
from collections.abc import AsyncGenerator, Callable, Sequence
from typing import Any

import pytest
from httpx import AsyncClient

from tests.helpers import fetch_one, insert_user
from vox_api.llm.base import LLMError, Message, StreamChunk, Turn
from vox_api.llm.fake import FakeProvider
from vox_api.services.chat import Usage, chat_events, offline_reply, sentences

Mint = Callable[..., str]


class ScriptedStream(FakeProvider):
    """Streams the given chunks, then optionally fails."""

    def __init__(
        self, chunks: list[str], *, fail_after: int | None = None, usage: tuple[int, int] = (0, 0)
    ) -> None:
        super().__init__()
        self.chunks, self.fail_after, self.usage = chunks, fail_after, usage
        self.closed = False

    async def stream(
        self,
        messages: Sequence[Message | Turn],
        *,
        system: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncGenerator[StreamChunk]:
        self.calls.append(tuple(messages))
        try:
            for i, text in enumerate(self.chunks):
                if self.fail_after is not None and i >= self.fail_after:
                    raise LLMError("upstream stream broke")
                yield StreamChunk(text)
            yield StreamChunk("", *self.usage)
        finally:
            self.closed = True


def read_sse(text: str) -> list[tuple[str, Any]]:
    events = []
    for block in filter(None, (b.strip() for b in text.split("\n\n"))):
        lines = dict(line.split(": ", 1) for line in block.split("\n"))
        events.append((lines["event"], json.loads(lines["data"])))
    return events


async def post_chat(
    client: AsyncClient, token: str, body: dict[str, Any]
) -> tuple[int, list[tuple[str, Any]]]:
    res = await client.post("/v1/chat", json=body, headers={"Authorization": f"Bearer {token}"})
    return res.status_code, read_sse(res.text) if res.status_code == 200 else []


async def test_happy_path_streams_meta_tokens_sentences_done_and_meters(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    llm = ScriptedStream(["The capital ", "of France ", "is Paris. ", "It is in Europe."], usage=(20, 11))
    use_llm(llm)
    me = await insert_user(database_url)

    status, events = await post_chat(
        client,
        mint_token(me),
        {"user_text": "capital of France?", "history": [{"role": "assistant", "text": "Hi"}]},
    )

    assert status == 200
    names = [e for e, _ in events]
    assert names[0] == "meta"
    assert events[0][1]["engine"] == "gemini"
    assert events[0][1]["first_token_ms"] >= 0
    assert names[-1] == "done"
    assert (
        "".join(d["text"] for e, d in events if e == "token")
        == "The capital of France is Paris. It is in Europe."
    )
    assert [d["text"] for e, d in events if e == "sentence"] == [
        "The capital of France is Paris.",
        "It is in Europe.",
    ]
    assert [m.role for m in llm.calls[0]] == ["model", "user"]  # history mapped to Gemini roles
    usage = await fetch_one(
        database_url, "select tokens_in, tokens_out from token_usage where user_id = $1", me
    )
    assert usage == {"tokens_in": 20, "tokens_out": 11}


async def test_offline_when_no_model(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(None)
    me = await insert_user(database_url)
    _, events = await post_chat(client, mint_token(me), {"user_text": "hello there"})
    assert events[0] == ("meta", {"engine": "offline", "reason": "GEMINI_API_KEY not configured"})
    assert [d["text"] for e, d in events if e == "sentence"] == [
        "Hello!",
        "I'm your voice assistant.",
        "What can I do for you?",
    ]
    assert events[-1][0] == "done"


async def test_offline_when_the_stream_breaks_before_the_first_token(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(ScriptedStream(["never"], fail_after=0))
    me = await insert_user(database_url)
    _, events = await post_chat(client, mint_token(me), {"user_text": "tell me"})
    assert events[0][1] == {"engine": "offline", "reason": "Gemini upstream failed"}
    assert events[-1][0] == "done"


async def test_error_not_done_when_the_stream_breaks_mid_reply(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(ScriptedStream(["First sentence. ", "Second on"], fail_after=1))
    me = await insert_user(database_url)
    _, events = await post_chat(client, mint_token(me), {"user_text": "tell me something"})
    names = [e for e, _ in events]
    assert names[0] == "meta"
    assert names[-1] == "error"
    assert "done" not in names


@pytest.mark.parametrize(
    "body",
    [
        {"user_text": "   "},
        {"user_text": "x" * 2001},
        {"user_text": "hi", "history": [{"role": "user", "text": "x"}] * 21},
        {"user_text": "hi", "history": [{"role": "robot", "text": "x"}]},
        {},
    ],
)
async def test_invalid_bodies_are_422(
    client: AsyncClient, mint_token: Mint, database_url: str, body: dict[str, Any]
) -> None:
    me = await insert_user(database_url)
    status, _ = await post_chat(client, mint_token(me), body)
    assert status == 422


async def test_chat_requires_authentication(client: AsyncClient) -> None:
    assert (await client.post("/v1/chat", json={"user_text": "hi"})).status_code == 401


async def test_chat_is_rate_limited(
    client: AsyncClient, mint_token: Mint, database_url: str, use_llm: Callable[[Any], None]
) -> None:
    use_llm(None)
    me = await insert_user(database_url)
    statuses = [(await post_chat(client, mint_token(me), {"user_text": "hi"}))[0] for _ in range(31)]
    assert statuses[:30] == [200] * 30
    assert statuses[30] == 429


async def test_closing_the_stream_closes_the_upstream_model_stream() -> None:
    llm = ScriptedStream(["One. ", "Two. ", "Three."])
    gen = chat_events(llm, "story", [], Usage())
    await gen.__anext__()  # meta
    await gen.aclose()  # the client went away
    assert llm.closed


def test_sentence_splitting_matches_the_web() -> None:
    assert sentences("Hi there. How are") == ["Hi there. ", "How are"]
    assert sentences("Wow! Really? Yes.") == ["Wow! ", "Really? ", "Yes."]
    assert sentences("") == []


def test_offline_replies() -> None:
    now = dt.datetime(2026, 11, 22, 9, 5, 3)
    assert offline_reply("what time is it", now) == "It's 9:05:03 AM."
    assert offline_reply("what's the date today", now) == "Today is Sunday, November 22, 2026."
    assert offline_reply("thanks!", now) == "You're welcome!"
    assert offline_reply("Blue sky", now).startswith("You said: Blue sky.")
