"""Health and readiness response bodies."""

from typing import Literal

from pydantic import BaseModel


class Health(BaseModel):
    status: Literal["ok"] = "ok"


class Readiness(BaseModel):
    status: Literal["ready"] = "ready"
    database: Literal["ok"] = "ok"
