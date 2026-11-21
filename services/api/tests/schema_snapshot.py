"""Normalised catalog snapshot of the public schema, for comparing two databases.

Covers what pg_dump --schema-only shows for our tables: columns (in physical
order, with types, nullability and defaults), constraints (PK, unique, FK
with actions), indexes and the extensions present. Alembic's own
alembic_version table is excluded.
"""

from typing import Any

import asyncpg

_EXCLUDED_TABLES = ("alembic_version",)


async def schema_snapshot(dsn: str) -> dict[str, Any]:
    conn = await asyncpg.connect(dsn)
    try:
        columns = await conn.fetch(
            """
            select c.relname as table, a.attnum as position, a.attname as column,
                   format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
                   pg_get_expr(d.adbin, d.adrelid) as default
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid and c.relkind = 'r'
            join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attnum > 0 and not a.attisdropped and c.relname <> all($1::text[])
            order by 1, 2
            """,
            list(_EXCLUDED_TABLES),
        )
        constraints = await conn.fetch(
            """
            select cl.relname as table, con.conname as name, pg_get_constraintdef(con.oid) as definition
            from pg_constraint con
            join pg_class cl on cl.oid = con.conrelid
            join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
            where cl.relname <> all($1::text[])
            order by 1, 2
            """,
            list(_EXCLUDED_TABLES),
        )
        indexes = await conn.fetch(
            "select tablename as table, indexname as name, indexdef as definition from pg_indexes"
            " where schemaname = 'public' and tablename <> all($1::text[]) order by 1, 2",
            list(_EXCLUDED_TABLES),
        )
        extensions = await conn.fetch(
            "select extname as name, extnamespace::regnamespace::text as schema from pg_extension order by 1"
        )
    finally:
        await conn.close()
    return {
        "columns": [dict(r) for r in columns],
        "constraints": [dict(r) for r in constraints],
        "indexes": [dict(r) for r in indexes],
        "extensions": [dict(r) for r in extensions],
    }
