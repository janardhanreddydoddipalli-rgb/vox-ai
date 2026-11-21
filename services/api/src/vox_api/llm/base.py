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
class ToolCall:
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ToolSpec:
    """A function the model may call: JSON-schema-ish parameters (Gemini's OpenAPI subset)."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class Turn:
    """One conversation turn: text, the model's tool calls, or the tool results sent back."""

    role: Role
    text: str | None = None
    calls: tuple[ToolCall, ...] = ()
    results: tuple[tuple[str, Any], ...] = ()  # (tool name, result) pairs


@dataclass(frozen=True)
class ModelTurn:
    text: str
    calls: list[ToolCall]
    tokens_in: int
    tokens_out: int


Conversation = Sequence[Message | Turn]


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
        messages: Conversation,
        *,
        system: str | None = None,
        response_schema: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> Generation:
        """One complete reply. With response_schema the reply text is JSON matching it."""
        ...

    async def generate_turn(
        self,
        turns: Conversation,
        *,
        system: str | None,
        tools: Sequence[ToolSpec],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> ModelTurn:
        """One function-calling round: either tool calls or the final text."""
        ...

    def stream(
        self,
        messages: Conversation,
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
