"""M26 — persistent named sessions.

Adds a ``sessions`` table so user-named session tabs survive hub
restart and sync across every Tailscale-reachable device. Each row
carries a server-generated UUID (``session_id``) plus a
container-scoped ``name`` and ``kind`` ("shell" | "claude").

Revision ID: m26_sessions
Revises: 1f4d0a7e5c21
Create Date: 2026-04-20 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "m26_sessions"
down_revision: str | Sequence[str] | None = "1f4d0a7e5c21"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("session_id", sa.String(length=64), primary_key=True),
        sa.Column("container_id", sa.Integer, nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.ForeignKeyConstraint(
            ["container_id"],
            ["containers.id"],
            ondelete="CASCADE",
        ),
    )
    op.create_index(
        "ix_sessions_container_id",
        "sessions",
        ["container_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_container_id", table_name="sessions")
    op.drop_table("sessions")
