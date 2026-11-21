"""The provider boundary every model call goes through (Gemini arrives in M3; tests use FakeProvider)."""

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

Role = Literal["user", "model"]
EmbeddingTask = Literal["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"]


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


@runtime_checkable
class LLMProvider(Protocol):
    """Every paid path reports token usage (tokens_in/out) so the cost guard can record it."""

    async def generate(self, messages: Sequence[Message], *, system: str | None = None) -> Generation:
        """One complete reply."""
        ...

    def stream(self, messages: Sequence[Message], *, system: str | None = None) -> AsyncIterator[str]:
        """The reply as text chunks, in order."""
        ...

    async def embed(self, texts: Sequence[str], *, task: EmbeddingTask) -> list[list[float]]:
        """Unit-length vectors, one per text, EMBEDDING_DIMENSIONS long."""
        ...
