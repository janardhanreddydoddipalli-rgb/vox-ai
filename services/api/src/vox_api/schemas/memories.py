"""Long-term memories the interviewer keeps about a candidate."""

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict

MemoryKind = Literal["strength", "weakness", "preference"]


class Memory(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: str
    text: str
    created_at: dt.datetime


class MemoryList(BaseModel):
    memories: list[Memory]
