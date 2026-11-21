"""Direct-SQL seeding for tests (bypasses the API so tests set up exactly what they need)."""

import datetime as dt
import uuid

import asyncpg

ZERO_VECTOR = "[" + ",".join(["0"] * 768) + "]"


def dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def insert_user(database_url: str, email: str | None = None) -> uuid.UUID:
    conn = await asyncpg.connect(dsn(database_url))
    try:
        row = await conn.fetchrow(
            "insert into users (email, name) values ($1, 'Test User') returning id",
            email or f"u-{uuid.uuid4().hex[:8]}@example.com",
        )
    finally:
        await conn.close()
    assert row is not None
    return uuid.UUID(str(row["id"]))


async def insert_memory(
    database_url: str, user_id: uuid.UUID, text: str, kind: str = "weakness", created_at: str | None = None
) -> uuid.UUID:
    conn = await asyncpg.connect(dsn(database_url))
    try:
        row = await conn.fetchrow(
            "insert into user_memories (user_id, kind, text, embedding, created_at)"
            " values ($1, $2, $3, $4::vector, coalesce($5::timestamptz, now())) returning id",
            user_id,
            kind,
            text,
            ZERO_VECTOR,
            dt.datetime.fromisoformat(created_at) if created_at else None,
        )
    finally:
        await conn.close()
    assert row is not None
    return uuid.UUID(str(row["id"]))


async def count_rows(database_url: str, table: str, where: str = "true", *args: object) -> int:
    conn = await asyncpg.connect(dsn(database_url))
    try:
        return int(await conn.fetchval(f"select count(*) from {table} where {where}", *args))  # noqa: S608 - test-only, fixed table names
    finally:
        await conn.close()
