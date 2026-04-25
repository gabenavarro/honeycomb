"""M27 — diff_events table for the Claude diff changelog.

Records each Edit/Write/MultiEdit tool call's unified diff so the
dashboard can render a per-container changelog. 200-event cap is
enforced at insert time by the service layer (no DB-level constraint).

Revision ID: m27_diff_events
Revises: m28_position
Create Date: 2026-04-23 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "m27_diff_events"
down_revision: str | Sequence[str] | None = "m28_position"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "diff_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("event_id", sa.Text, nullable=False, unique=True),
        sa.Column(
            "container_id",
            sa.Integer,
            sa.ForeignKey("containers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("claude_session_id", sa.Text, nullable=True),
        sa.Column("tool_use_id", sa.Text, nullable=False),
        sa.Column("tool", sa.Text, nullable=False),
        sa.Column("path", sa.Text, nullable=False),
        sa.Column("diff", sa.Text, nullable=False),
        sa.Column("added_lines", sa.Integer, nullable=False, server_default="0"),
        sa.Column("removed_lines", sa.Integer, nullable=False, server_default="0"),
        sa.Column("size_bytes", sa.Integer, nullable=False),
        sa.Column("timestamp", sa.Text, nullable=False),
        sa.Column("created_at", sa.Text, nullable=False),
        sa.CheckConstraint(
            "tool IN ('Edit', 'Write', 'MultiEdit')",
            name="ck_diff_events_tool",
        ),
    )
    op.create_index(
        "ix_diff_events_container_created",
        "diff_events",
        ["container_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_diff_events_container_created", table_name="diff_events")
    op.drop_table("diff_events")
