"""m33 add claude_session_id to named_sessions

Revision ID: 54e3c80eb978
Revises: m27_diff_events
Create Date: 2026-04-26 08:18:43.728762+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "54e3c80eb978"
down_revision: str | Sequence[str] | None = "m27_diff_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("claude_session_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "claude_session_id")
