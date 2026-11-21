"""Deterministic provider for tests and CI: no network, same input → same output."""

import hashlib
import math
import random
from collections.abc import AsyncIterator, Sequence
from typing import Any

from vox_api.llm.base import EmbeddingTask, Generation, Message
from vox_api.models.memory import EMBEDDING_DIMENSIONS


def _tokens(text: str) -> int:
    return max(1, len(text.split()))


class FakeProvider:
    """Replies with scripted text (in order) or echoes the last user message."""

    model = "fake-1"

    def __init__(self, replies: Sequence[str] = ()) -> None:
        self._replies = list(replies)
        self.calls: list[tuple[Message, ...]] = []

    def _next_reply(self, messages: Sequence[Message]) -> str:
        self.calls.append(tuple(messages))
        if self._replies:
            return self._replies.pop(0)
        last_user = next((m.text for m in reversed(messages) if m.role == "user"), "")
        return f"echo: {last_user}"

    async def generate(
        self,
        messages: Sequence[Message],
        *,
        system: str | None = None,
        response_schema: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> Generation:
        reply = self._next_reply(messages)
        prompt = " ".join(filter(None, [system, *(m.text for m in messages)]))
        return Generation(text=reply, tokens_in=_tokens(prompt), tokens_out=_tokens(reply), model=self.model)

    async def stream(self, messages: Sequence[Message], *, system: str | None = None) -> AsyncIterator[str]:
        reply = self._next_reply(messages)
        for i, word in enumerate(reply.split(" ")):
            yield word if i == 0 else f" {word}"

    async def embed(self, texts: Sequence[str], *, task: EmbeddingTask) -> list[list[float]]:
        return [_unit_vector(f"{task}:{t}") for t in texts]


def _unit_vector(seed_text: str) -> list[float]:
    seed = int.from_bytes(hashlib.sha256(seed_text.encode()).digest()[:8], "big")
    rng = random.Random(seed)  # noqa: S311 - deterministic test data, not security
    v = [rng.gauss(0.0, 1.0) for _ in range(EMBEDDING_DIMENSIONS)]
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]
