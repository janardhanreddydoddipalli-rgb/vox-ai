"""Test fixtures: a real Postgres 18 + pgvector, migrated by Alembic; an app with test keys.

Database server: TEST_DATABASE_URL if set (the CI service container, or a local
one), otherwise a throwaway testcontainers pgvector/pgvector:pg18 (needs Docker).
That database is migrated once per run and used as a template: each pytest-xdist
worker (or the single process) tests in its own copy, so `pytest -n auto` is safe.
"""

import asyncio
import datetime as dt
import os
import subprocess
import sys
import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path
from typing import Any

import asyncpg
import jwt
import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from vox_api.core.config import Settings
from vox_api.main import create_app

API_DIR = Path(__file__).resolve().parents[1]
PG_IMAGE = "pgvector/pgvector:pg18"  # same engine as Neon production (Postgres 18.7, pgvector 0.8.7)
WEB_ORIGIN = "http://localhost:3000"
INTERNAL_TOKEN = "test-internal-token-0123456789abcdef"


def run_alembic(database_url: str, *args: str) -> None:
    """Run the real Alembic CLI (as production does) against a database."""
    subprocess.run(  # noqa: S603 - fixed argv: this interpreter running alembic
        [sys.executable, "-m", "alembic", *args],
        cwd=API_DIR,
        env={**os.environ, "DATABASE_URL": database_url},
        check=True,
        capture_output=True,
    )


@pytest.fixture(scope="session")
def admin_database_url() -> Iterator[str]:
    """A Postgres server we may create databases on."""
    if url := os.environ.get("TEST_DATABASE_URL"):
        yield url
        return
    from testcontainers.community.postgres import PostgresContainer

    with PostgresContainer(PG_IMAGE, username="vox", password="vox", dbname="vox_test", driver=None) as pg:
        yield pg.get_connection_url()


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _on_database(url: str, name: str) -> str:
    """The same server and credentials, another database."""
    return _dsn(url).rsplit("/", 1)[0] + f"/{name}"


def _database_name(url: str) -> str:
    return _dsn(url).rsplit("/", 1)[1].split("?", 1)[0]


_TEMPLATE_LOCK = 715_001  # advisory lock key: one worker at a time migrates or copies the template


async def _worker_database(admin_url: str, worker: str) -> str:
    template = _database_name(admin_url)
    head = ScriptDirectory.from_config(Config(str(API_DIR / "alembic.ini"))).get_current_head()
    # Admin work happens on the maintenance database: Postgres refuses to copy a
    # template while any session is connected to it.
    conn = await asyncpg.connect(_on_database(admin_url, "postgres"))
    try:
        await conn.execute("SELECT pg_advisory_lock($1)", _TEMPLATE_LOCK)
        try:
            tpl = await asyncpg.connect(_dsn(admin_url))
            try:
                has_version = await tpl.fetchval("SELECT to_regclass('public.alembic_version') IS NOT NULL")
                current = (
                    await tpl.fetchval("SELECT version_num FROM alembic_version") if has_version else None
                )
            finally:
                await tpl.close()
            if current != head:
                run_alembic(admin_url, "upgrade", "head")  # once per run, by whichever worker is first
            name = f"{template}_{worker}"
            await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            await conn.execute(f'CREATE DATABASE "{name}" TEMPLATE "{template}"')
        finally:
            await conn.execute("SELECT pg_advisory_unlock($1)", _TEMPLATE_LOCK)
    finally:
        await conn.close()
    return _on_database(admin_url, name)


@pytest.fixture(scope="session")
def database_url(admin_database_url: str, worker_id: str) -> str:
    """This worker's own migrated database ("master" when not running under xdist)."""
    return asyncio.run(_worker_database(admin_database_url, worker_id))


@pytest.fixture
async def make_database(admin_database_url: str) -> AsyncIterator[Callable[[str], Any]]:
    """Create empty, uniquely named databases on the same server; dropped afterwards."""
    created: list[str] = []
    maintenance = _on_database(admin_database_url, "postgres")

    async def _make(prefix: str) -> str:
        name = f"{prefix}_{uuid.uuid4().hex[:8]}"
        conn = await asyncpg.connect(maintenance)
        try:
            await conn.execute(f'CREATE DATABASE "{name}"')
        finally:
            await conn.close()
        created.append(name)
        return _on_database(admin_database_url, name)

    yield _make
    conn = await asyncpg.connect(maintenance)
    try:
        for name in created:
            await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def signing_key() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


def public_pem(key: Ed25519PrivateKey) -> str:
    return (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )


@pytest.fixture(scope="session")
def settings(database_url: str, signing_key: Ed25519PrivateKey) -> Settings:
    return Settings(
        _env_file=None,  # never read a developer's .env in tests
        environment="test",
        database_url=SecretStr(database_url),
        web_origin=WEB_ORIGIN,
        jwt_public_key=SecretStr(public_pem(signing_key)),
        internal_api_token=SecretStr(INTERNAL_TOKEN),
    )


@pytest.fixture(scope="session")
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as c:
        yield c


@pytest.fixture(autouse=True)
async def _clean_tables(request: pytest.FixtureRequest) -> None:
    """Empty every user table before DB-backed tests (the question bank is reference data)."""
    if "database_url" not in request.fixturenames and "app" not in request.fixturenames:
        return
    url = _dsn(request.getfixturevalue("database_url"))
    conn = await asyncpg.connect(url)
    try:
        await conn.execute("TRUNCATE users, sessions CASCADE")
    finally:
        await conn.close()


@pytest.fixture
def mint_token(signing_key: Ed25519PrivateKey) -> Callable[..., str]:
    """Mint a token exactly as apps/web does; override claims to build bad ones."""

    def _mint(sub: uuid.UUID | str, *, key: Any = None, algorithm: str = "EdDSA", **overrides: Any) -> str:
        now = dt.datetime.now(dt.UTC)
        claims: dict[str, Any] = {
            "iss": "vox-web",
            "aud": "vox-api",
            "sub": str(sub),
            "jti": uuid.uuid4().hex,
            "iat": now,
            "exp": now + dt.timedelta(minutes=5),
        }
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(claims, key if key is not None else signing_key, algorithm=algorithm)

    return _mint


@pytest.fixture
async def user_id(database_url: str) -> uuid.UUID:
    conn = await asyncpg.connect(_dsn(database_url))
    try:
        row = await conn.fetchrow(
            "insert into users (email, name) values ($1, 'Test User') returning id",
            f"u-{uuid.uuid4().hex[:6]}@example.com",
        )
    finally:
        await conn.close()
    assert row is not None
    return uuid.UUID(str(row["id"]))


@pytest.fixture
def use_llm(app: FastAPI) -> Iterator[Callable[[Any], None]]:
    """Swap the app's model provider for one test (None = no model configured)."""
    original = app.state.llm

    def _set(llm: Any) -> None:
        app.state.llm = llm

    yield _set
    app.state.llm = original


def resume_pdf(lines: list[str]) -> bytes:
    """A real, text-extractable PDF (built with our own report writer)."""
    from vox_api.services.report_pdf import Line, build_pdf

    return build_pdf([Line(text, 11) for text in lines])
