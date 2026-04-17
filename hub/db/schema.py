"""SQLAlchemy Core metadata for the hub registry (M7).

We use Core rather than the ORM because:

* The Registry API already returns Pydantic models — we don't need
  a second object layer for the same rows.
* Core keeps ``text()`` + ``insert()`` queries explicit, so the SQL
  the hub actually issues matches the Alembic migrations one-to-one.

Adding a new column
-------------------
1. Add the column to :data:`containers` below.
2. Generate a migration with::

       alembic -c hub/db/alembic.ini revision --autogenerate -m "describe the change"

3. Inspect the generated file in ``hub/db/migrations/versions/`` and
   add any data-migration SQL the autogenerator couldn't infer.
4. Add the column name to :data:`hub.services.registry.ALLOWED_UPDATE_FIELDS`
   if the field should be writable via ``Registry.update(**fields)``.
"""

from __future__ import annotations

import sqlalchemy as sa

# One MetaData object holds every table. Alembic's env.py imports it
# for autogenerate; the Registry uses it for insert/select queries.
metadata = sa.MetaData()


# ── containers ──────────────────────────────────────────────────────

# Enum values live as string columns (TEXT) rather than DB-level enums
# because SQLite's CHECK-based enum simulation is awkward to migrate,
# and the hub's Pydantic models are the real validation edge. Dozens of
# tests build ContainerStatus/AgentStatus directly from the string
# column.
containers = sa.Table(
    "containers",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("workspace_folder", sa.Text, nullable=False, unique=True),
    sa.Column("project_type", sa.Text, nullable=False, server_default="base"),
    sa.Column("project_name", sa.Text, nullable=False),
    sa.Column("project_description", sa.Text, nullable=False, server_default=""),
    sa.Column("git_repo_url", sa.Text, nullable=True),
    sa.Column("container_id", sa.Text, nullable=True),
    sa.Column("container_status", sa.Text, nullable=False, server_default="unknown"),
    sa.Column("agent_status", sa.Text, nullable=False, server_default="unreachable"),
    sa.Column("agent_port", sa.Integer, nullable=False, server_default="9100"),
    # Booleans ship as INTEGER (0/1) in SQLite. SQLAlchemy's Boolean
    # type handles the coercion.
    sa.Column("has_gpu", sa.Boolean, nullable=False, server_default=sa.text("0")),
    sa.Column("has_claude_cli", sa.Boolean, nullable=False, server_default=sa.text("0")),
    sa.Column("claude_cli_checked_at", sa.Text, nullable=True),
    sa.Column("created_at", sa.Text, nullable=False),
    sa.Column("updated_at", sa.Text, nullable=False),
)
