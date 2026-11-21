"""The Alembic baseline (0001) must build exactly the schema Drizzle built (0000-0008).

The fixture was generated once from a database migrated by apps/web's
Drizzle migrations; Drizzle is frozen, so it never changes. Later Alembic
revisions are free to evolve the schema: this test pins revision 0001 only.
"""

import json
from pathlib import Path
from typing import Any

from tests.conftest import run_alembic
from tests.schema_snapshot import schema_snapshot

FIXTURE = Path(__file__).parent / "fixtures" / "drizzle_schema_snapshot.json"


async def test_alembic_baseline_matches_the_drizzle_schema(make_database: Any) -> None:
    url = await make_database("baseline")
    run_alembic(url, "upgrade", "0001")

    expected = json.loads(FIXTURE.read_text())
    expected.pop("_source")
    actual = await schema_snapshot(url)

    for section in ("columns", "constraints", "indexes", "extensions"):
        assert actual[section] == expected[section], f"{section} differ from the Drizzle schema"


async def test_baseline_downgrade_removes_every_table(make_database: Any) -> None:
    url = await make_database("downgrade")
    run_alembic(url, "upgrade", "0001")
    run_alembic(url, "downgrade", "base")
    snapshot = await schema_snapshot(url)
    assert snapshot["columns"] == []
    assert {e["name"] for e in snapshot["extensions"]} == {"plpgsql", "vector"}  # extension kept on purpose
