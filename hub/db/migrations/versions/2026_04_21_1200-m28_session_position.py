"""M28 — session position column.

Adds a 1-based ``position`` slot to the sessions table so users can
drag-reorder tabs and have the order persist server-side. Existing
rows default to 0 and are renumbered atomically on the first
reorder in their container.

Revision ID: m28_position
Revises: m26_sessions
Create Date: 2026-04-21 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "m28_position"
down_revision: str | Sequence[str] | None = "m26_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column(
            "position",
            sa.Integer,
            nullable=False,
            server_default="0",
        ),
    )
    op.create_index(
        "ix_sessions_container_position",
        "sessions",
        ["container_id", "position"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_sessions_container_position",
        table_name="sessions",
    )
    op.drop_column("sessions", "position")
