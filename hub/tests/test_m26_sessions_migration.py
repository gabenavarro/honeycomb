"""M26 — verify Alembic creates the sessions table with correct shape."""

from __future__ import annotations

from pathlib import Path

import pytest
import sqlalchemy as sa


@pytest.mark.asyncio
async def test_sessions_table_exists_after_migration(tmp_path: Path) -> None:
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")
    inspector = sa.inspect(engine)
    assert "sessions" in inspector.get_table_names()

    cols = {c["name"]: c for c in inspector.get_columns("sessions")}
    assert set(cols) == {
        "session_id",
        "container_id",
        "name",
        "kind",
        "created_at",
        "updated_at",
        "position",
    }
    assert cols["session_id"]["primary_key"] == 1

    fks = inspector.get_foreign_keys("sessions")
    assert len(fks) == 1
    assert fks[0]["referred_table"] == "containers"
    assert fks[0]["referred_columns"] == ["id"]
    # SQLite stores on_delete as a string.
    assert fks[0].get("options", {}).get("ondelete", "").upper() == "CASCADE"

    indexes = inspector.get_indexes("sessions")
    by_name = {ix["name"]: ix for ix in indexes}
    assert "ix_sessions_container_id" in by_name
    assert by_name["ix_sessions_container_id"]["column_names"] == ["container_id"]


@pytest.mark.asyncio
async def test_cascade_on_container_delete(tmp_path: Path) -> None:
    """Deleting a container wipes its session rows via FK CASCADE."""
    from hub.db.migrations_runner import apply_migrations_sync

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    engine = sa.create_engine(f"sqlite:///{db_path}")

    # SQLite needs foreign_keys=ON per-connection.
    @sa.event.listens_for(engine, "connect")
    def _fk_on(conn, _r):
        conn.execute("PRAGMA foreign_keys=ON")

    with engine.begin() as conn:
        # Insert a container row. Columns mirror the M13 schema.
        # created_at/updated_at are NOT NULL without a server_default in
        # SQLite, so we supply them explicitly.
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-01-01T00:00:00','2026-01-01T00:00:00')",
            ),
        )
        cid_row = conn.execute(sa.text("SELECT id FROM containers LIMIT 1")).first()
        assert cid_row is not None
        container_id = cid_row[0]
        conn.execute(
            sa.text(
                "INSERT INTO sessions "
                "(session_id, container_id, name, kind) "
                "VALUES ('abc',:cid,'Main','shell')",
            ),
            {"cid": container_id},
        )
        conn.execute(sa.text("DELETE FROM containers WHERE id = :cid"), {"cid": container_id})
        left = conn.execute(sa.text("SELECT COUNT(*) FROM sessions")).scalar()
        assert left == 0
