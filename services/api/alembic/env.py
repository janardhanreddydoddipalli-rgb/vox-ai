"""Alembic environment: async engine from DATABASE_URL, metadata from vox_api.models.

Only DATABASE_URL is needed (not the app's other settings), so migrations can
run from CI or a laptop without JWT keys or service tokens. Use Neon's
*direct* (non-pooler) URL for migrations.
"""

import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from vox_api.core.config import async_database_url
from vox_api.models import Base

# Log "Running upgrade ..." lines as configured in alembic.ini.
if context.config.config_file_name is not None:
    fileConfig(context.config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("alembic: DATABASE_URL is not set")
    return async_database_url(url)


def run_migrations_offline() -> None:
    context.configure(
        url=_url(), target_metadata=target_metadata, literal_binds=True, compare_server_default=True
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_server_default=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(_url(), poolclass=pool.NullPool, connect_args={"statement_cache_size": 0})
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
