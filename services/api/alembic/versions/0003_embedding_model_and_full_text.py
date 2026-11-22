"""Embedding model and size per row; full-text search on doc chunks (expand-only).

user_memories and doc_chunks record which model produced each vector, so vectors
from different models are never compared. The defaults describe every existing
row (gemini-embedding-001 at 768 dimensions) and what apps/web still writes; they
are dropped in the contract step once the web stops writing these tables (M4).
doc_chunks.tsv is the full-text side of hybrid retrieval ('simple': no stemming,
so Hindi, Tamil and Telugu match as well as English).

Revision ID: 0003
Revises: 0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = ("user_memories", "doc_chunks")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(
            table,
            sa.Column(
                "embedding_model", sa.Text(), server_default=sa.text("'gemini-embedding-001'"), nullable=False
            ),
        )
        op.add_column(
            table, sa.Column("embedding_dim", sa.Integer(), server_default=sa.text("768"), nullable=False)
        )
    op.add_column(
        "doc_chunks",
        sa.Column(
            "tsv",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple'::regconfig, text)", persisted=True),
            nullable=True,
        ),
    )
    op.create_index("doc_chunks_tsv_idx", "doc_chunks", ["tsv"], unique=False, postgresql_using="gin")


def downgrade() -> None:
    op.drop_index("doc_chunks_tsv_idx", table_name="doc_chunks", postgresql_using="gin")
    op.drop_column("doc_chunks", "tsv")
    for table in TABLES:
        op.drop_column(table, "embedding_dim")
        op.drop_column(table, "embedding_model")
