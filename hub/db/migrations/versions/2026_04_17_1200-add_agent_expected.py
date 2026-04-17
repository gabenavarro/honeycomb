"""add agent_expected column

M13. Distinguishes containers where a hive-agent is expected to send
heartbeats (bootstrapped via our templates) from containers registered
"bare" via the Discover tab, where docker_exec is the only transport
and heartbeat silence is not a failure.

Revision ID: 1f4d0a7e5c21
Revises: 80a461aca9bf
Create Date: 2026-04-17 12:00:00.000000+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "1f4d0a7e5c21"
down_revision: str | Sequence[str] | None = "80a461aca9bf"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Server default 1 keeps existing rows backwards-compatible: anything
    # already in the DB was either bootstrapped (legit ``agent_expected``)
    # or discovered pre-M13 (``agent_status=unreachable`` already stuck
    # to them for the same reason this column now fixes). Flipping the
    # default for fresh registrations happens at the application layer
    # in hub/routers/discover.py.
    op.add_column(
        "containers",
        sa.Column(
            "agent_expected",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )


def downgrade() -> None:
    op.drop_column("containers", "agent_expected")
