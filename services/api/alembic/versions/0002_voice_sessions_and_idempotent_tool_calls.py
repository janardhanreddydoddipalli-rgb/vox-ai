"""Voice sessions and idempotent voice tool calls (expand-only: two new tables).

Live tool calls and usage reports are keyed by a server-issued voice_sessions.id
bound to one user (and optionally one interview), so the browser never names the
interview a tool acts on. A retried Gemini call_id returns the stored output
instead of running the tool again.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "voice_sessions",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("interview_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("tokens_in", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("tokens_out", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.ForeignKeyConstraint(
            ["interview_id"], ["interviews.id"], name="voice_sessions_interview_id_fk", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="voice_sessions_user_id_fk", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("voice_sessions_user_id_idx", "voice_sessions", ["user_id"], unique=False)
    op.create_table(
        "voice_tool_calls",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("voice_session_id", sa.UUID(), nullable=False),
        sa.Column("call_id", sa.Text(), nullable=False),
        sa.Column("tool_name", sa.Text(), nullable=False),
        sa.Column("output", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["voice_session_id"],
            ["voice_sessions.id"],
            name="voice_tool_calls_session_fk",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("voice_session_id", "call_id", name="voice_tool_calls_session_call_key"),
    )


def downgrade() -> None:
    op.drop_table("voice_tool_calls")
    op.drop_index("voice_sessions_user_id_idx", table_name="voice_sessions")
    op.drop_table("voice_sessions")
