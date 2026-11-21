"""Declarative base and column helpers shared by every model."""

import datetime as dt
import uuid
from typing import Annotated

from sqlalchemy import DateTime, Text, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, mapped_column


class Base(DeclarativeBase):
    pass


# Column shapes reused across tables. Server defaults live in the database
# (gen_random_uuid(), now()), matching the schema the Drizzle migrations built.
UuidPk = Annotated[
    uuid.UUID,
    mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")),
]
CreatedAt = Annotated[
    dt.datetime,
    mapped_column(DateTime(timezone=True), nullable=False, server_default=text("now()")),
]
Str = Annotated[str, mapped_column(Text, nullable=False)]
OptStr = Annotated[str | None, mapped_column(Text, nullable=True)]
