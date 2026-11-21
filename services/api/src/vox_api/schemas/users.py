"""User-facing and internal user schemas."""

import datetime as dt
import uuid

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class Me(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    name: str | None
    image: str | None
    created_at: dt.datetime


class UserUpsertIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr
    name: str | None = Field(default=None, max_length=200)
    image: str | None = Field(default=None, max_length=2048)


class UserUpsertOut(BaseModel):
    user_id: uuid.UUID
