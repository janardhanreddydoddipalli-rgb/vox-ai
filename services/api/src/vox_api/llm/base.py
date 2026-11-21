"""The provider boundary every model call goes through (Gemini in production, Fake in tests)."""

from collections.abc import AsyncGenerator, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["user", "model"]
EmbeddingTask = Literal["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]


class LLMError(Exception):
    """The model call failed (HTTP error, empty or malformed reply)."""


@dataclass(frozen=True)
class Message:
    role: Role
    text: str


@dataclass(frozen=True)
class Generation:
    text: str
    tokens_in: int
    tokens_out: int
    model: str


@dataclass(frozen=True)
class StreamChunk:
    """A piece of a streamed reply; the final chunk usually carries the token usage."""

    text: str
    tokens_in: int = 0
    tokens_out: int = 0


@runtime_checkable
class LLMProvider(Protocol):
    """Every paid path reports token usage (tokens_in/out) so the cost guard can record it."""

    async def generate(
        self,
        messages: Sequence[Message],
        *,
        system: str | None = None,
        response_schema: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> Generation:
        """One complete reply. With response_schema the reply text is JSON matching it."""
        ...

    def stream(
        self,
        messages: Sequence[Message],
        *,
        system: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncGenerator[StreamChunk]:
        """The reply as chunks, in order; usage arrives on the last ones."""
        ...

    async def embed(self, texts: Sequence[str], *, task: EmbeddingTask) -> list[list[float]]:
        """Unit-length vectors, one per text, EMBEDDING_DIMENSIONS long."""
        ...
