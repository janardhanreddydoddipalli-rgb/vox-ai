"""What every agent tool is: a name, a description, a Pydantic input model and a handler."""

import random
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.llm.base import LLMProvider, ToolSpec
from vox_api.models import Interview


@dataclass
class ToolUsage:
    """Tokens spent by model calls made inside tools (metered with the turn)."""

    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class ToolContext:
    db: AsyncSession
    llm: LLMProvider
    user_id: uuid.UUID
    # Loaded by the caller with an ownership check, so a tool can never reach
    # another user's interview: it gets the object, not an id to look up.
    interview: Interview | None
    usage: ToolUsage = field(default_factory=ToolUsage)
    rng: random.Random = field(default_factory=random.Random)


Handler = Callable[[Any, ToolContext], Awaitable[dict[str, Any]]]

_TYPES = {
    "string": "string",
    "integer": "integer",
    "number": "number",
    "boolean": "boolean",
    "array": "array",
}


def _gemini_type(prop: dict[str, Any]) -> dict[str, Any]:
    if "anyOf" in prop:  # Optional[...] → the non-null branch
        prop = next(p for p in prop["anyOf"] if p.get("type") != "null")
    out: dict[str, Any] = {"type": _TYPES.get(prop.get("type", "string"), "string")}
    if "enum" in prop:
        out["enum"] = prop["enum"]
    if out["type"] == "array":
        out["items"] = _gemini_type(prop.get("items", {"type": "string"}))
    return out


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_model: type[BaseModel]
    handler: Handler

    def spec(self) -> ToolSpec:
        schema = self.input_model.model_json_schema()
        properties = {k: _gemini_type(v) for k, v in schema.get("properties", {}).items()}
        return ToolSpec(
            self.name,
            self.description,
            {"type": "object", "properties": properties, "required": schema.get("required", [])},
        )
