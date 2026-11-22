"""Seed the question bank into DATABASE_URL. Idempotent: safe to re-run.

Usage (from services/api): DATABASE_URL=postgresql://... uv run python scripts/seed_questions.py
"""

import asyncio
import os

from vox_api.core.config import async_database_url
from vox_api.core.db import create_engine, create_session_factory
from vox_api.services import question_bank


async def main() -> None:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("seed_questions: DATABASE_URL is not set")
    engine = create_engine(async_database_url(url))
    try:
        async with create_session_factory(engine)() as db:
            added = await question_bank.seed(db)
            await db.commit()
    finally:
        await engine.dispose()
    print(f"Seeded {added} new questions ({len(question_bank.load())} in the bank).")


if __name__ == "__main__":
    asyncio.run(main())
