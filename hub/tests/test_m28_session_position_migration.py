"""M28 — verify Alembic adds the position column + index."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa


@pytest.mark.asyncio
async def test_position_column_added(tmp_path: Path) -> None:
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    inspector = sa.inspect(engine)
    cols = {c["name"]: c for c in inspector.get_columns("sessions")}
    assert "position" in cols
    assert cols["position"]["type"].__class__.__name__ in {"INTEGER", "Integer"}
    assert cols["position"]["nullable"] is False
    default = cols["position"].get("default")
    assert default is not None
    assert "0" in str(default)


@pytest.mark.asyncio
async def test_position_index_added(tmp_path: Path) -> None:
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    inspector = sa.inspect(engine)
    indexes = {ix["name"]: ix for ix in inspector.get_indexes("sessions")}
    assert "ix_sessions_container_position" in indexes
    assert indexes["ix_sessions_container_position"]["column_names"] == [
        "container_id",
        "position",
    ]


@pytest.mark.asyncio
async def test_existing_rows_default_to_zero(tmp_path: Path) -> None:
    """A row inserted without specifying position must default to 0."""
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")

    @sa.event.listens_for(engine, "connect")
    def _fk_on(conn, _r):
        conn.execute("PRAGMA foreign_keys=ON")

    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-21T00:00:00','2026-04-21T00:00:00')",
            ),
        )
        conn.execute(
            sa.text(
                "INSERT INTO sessions "
                "(session_id, container_id, name, kind, "
                "created_at, updated_at) "
                "VALUES ('abc',1,'Main','shell',"
                "'2026-04-21T00:00:00','2026-04-21T00:00:00')"
            ),
        )
        pos = conn.execute(
            sa.text("SELECT position FROM sessions WHERE session_id = 'abc'"),
        ).scalar()
        assert pos == 0
