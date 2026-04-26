"""m35 artifacts table

Revision ID: 3f08ca61df4e
Revises: 54e3c80eb978
Create Date: 2026-04-26 18:48:03.833419+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "3f08ca61df4e"
down_revision: str | Sequence[str] | None = "54e3c80eb978"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "artifacts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("artifact_id", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "container_id",
            sa.Integer(),
            sa.ForeignKey("containers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "type",
            sa.Text(),
            nullable=False,
        ),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("body_format", sa.Text(), nullable=False, server_default="markdown"),
        sa.Column("source_chat_id", sa.Text(), nullable=True),
        sa.Column("source_message_id", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=True),
        sa.Column("pinned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("archived", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "type IN ('plan','review','edit','snippet','note','skill','subagent','spec')",
            name="ck_artifacts_type",
        ),
    )
    op.create_index(
        "ix_artifacts_container_created",
        "artifacts",
        ["container_id", "archived", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_artifacts_type",
        "artifacts",
        ["container_id", "type", "archived", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_artifacts_source_chat",
        "artifacts",
        ["source_chat_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_artifacts_source_chat", table_name="artifacts")
    op.drop_index("ix_artifacts_type", table_name="artifacts")
    op.drop_index("ix_artifacts_container_created", table_name="artifacts")
    op.drop_table("artifacts")
