"""Deterministic provider for tests and CI: no network, same input → same output."""

import hashlib
import math
import random
from collections.abc import AsyncGenerator, Sequence
from typing import Any

from vox_api.llm.base import (
    Conversation,
    EmbeddingTask,
    Generation,
    Message,
    ModelTurn,
    StreamChunk,
    ToolSpec,
    Turn,
)
from vox_api.models.memory import EMBEDDING_DIMENSIONS


def _tokens(text: str) -> int:
    return max(1, len(text.split()))


class FakeProvider:
    """Replies with scripted text (in order) or echoes the last user message."""

    model = "fake-1"

    def __init__(self, replies: Sequence[str] = (), turns: Sequence[ModelTurn] = ()) -> None:
        self._replies = list(replies)
        self._turns = list(turns)
        self.calls: list[tuple[Message | Turn, ...]] = []
        # (conversation, offered tool names, system prompt) per generate_turn call
        self.turn_requests: list[tuple[tuple[Message | Turn, ...], tuple[str, ...], str | None]] = []

    def _next_reply(self, messages: Conversation) -> str:
        self.calls.append(tuple(messages))
        if self._replies:
            return self._replies.pop(0)
        last_user = next((m.text for m in reversed(messages) if m.role == "user" and m.text), "")
        return f"echo: {last_user}"

    async def generate_turn(
        self,
        turns: Conversation,
        *,
        system: str | None,
        tools: Sequence[ToolSpec],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> ModelTurn:
        """Scripted function-calling rounds (records the conversation and offered tools)."""
        self.turn_requests.append((tuple(turns), tuple(t.name for t in tools), system))
        if self._turns:
            return self._turns.pop(0)
        return ModelTurn(text=self._next_reply(turns), calls=[], tokens_in=1, tokens_out=1)

    async def generate(
        self,
        messages: Conversation,
        *,
        system: str | None = None,
        response_schema: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> Generation:
        reply = self._next_reply(messages)
        prompt = " ".join(filter(None, [system, *(m.text for m in messages if m.text)]))
        return Generation(text=reply, tokens_in=_tokens(prompt), tokens_out=_tokens(reply), model=self.model)

    async def stream(
        self,
        messages: Conversation,
        *,
        system: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncGenerator[StreamChunk]:
        reply = self._next_reply(messages)
        words = reply.split(" ")
        for i, word in enumerate(words):
            text = word if i == 0 else f" {word}"
            last = i == len(words) - 1
            prompt = " ".join(filter(None, [system, *(m.text for m in messages if m.text)]))
            yield StreamChunk(text, _tokens(prompt) if last else 0, _tokens(reply) if last else 0)

    async def embed(self, texts: Sequence[str], *, task: EmbeddingTask) -> list[list[float]]:
        return [_unit_vector(f"{task}:{t}") for t in texts]


def _unit_vector(seed_text: str) -> list[float]:
    seed = int.from_bytes(hashlib.sha256(seed_text.encode()).digest()[:8], "big")
    rng = random.Random(seed)  # noqa: S311 - deterministic test data, not security
    v = [rng.gauss(0.0, 1.0) for _ in range(EMBEDDING_DIMENSIONS)]
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]
