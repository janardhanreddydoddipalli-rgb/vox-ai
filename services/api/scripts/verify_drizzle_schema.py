"""Read-only check that a database still has exactly the Drizzle 0000-0008 schema.

Run before `alembic stamp 0001` on an existing database (docs/runbooks/alembic-cutover.md):

    uv run --env-file ../../apps/web/.env.neon.local python scripts/verify_drizzle_schema.py

Exit code 0 = identical (safe to stamp), 1 = drifted (do not stamp).
Only catalog SELECTs run, inside a read-only transaction.
"""

import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR))

from tests.schema_snapshot import schema_snapshot  # noqa: E402

FIXTURE = API_DIR / "tests" / "fixtures" / "drizzle_schema_snapshot.json"
SECTIONS = ("columns", "constraints", "indexes", "extensions")


def asyncpg_dsn(url: str) -> str:
    """asyncpg understands sslmode but not channel_binding."""
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k != "channel_binding"]
    return urlunsplit(("postgresql", parts.netloc, parts.path, urlencode(query), ""))


async def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2
    os.environ["PGOPTIONS"] = "-c default_transaction_read_only=on"  # belt and braces: no writes possible
    actual = await schema_snapshot(asyncpg_dsn(url))
    expected = json.loads(FIXTURE.read_text())
    ok = True
    for section in SECTIONS:
        same = actual[section] == expected[section]
        ok &= same
        print(f"{section:12} {'identical' if same else 'DIFFERENT'} ({len(actual[section])} rows)")
    print("RESULT: matches Drizzle 0000-0008, safe to stamp 0001" if ok else "RESULT: drifted, do NOT stamp")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
