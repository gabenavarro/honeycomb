"""Smoke test for the M27 diff_events table migration."""

from __future__ import annotations

from pathlib import Path

import sqlalchemy as sa

from hub.db.migrations_runner import apply_migrations_sync


def test_diff_events_table_exists_after_migration(tmp_path: Path) -> None:
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)

    eng = sa.create_engine(f"sqlite:///{db_path}")
    inspector = sa.inspect(eng)

    assert "diff_events" in inspector.get_table_names()

    cols = {c["name"]: c for c in inspector.get_columns("diff_events")}
    expected = {
        "id",
        "event_id",
        "container_id",
        "claude_session_id",
        "tool_use_id",
        "tool",
        "path",
        "diff",
        "added_lines",
        "removed_lines",
        "size_bytes",
        "timestamp",
        "created_at",
    }
    assert expected.issubset(cols.keys()), f"missing columns: {expected - cols.keys()}"
    assert cols["claude_session_id"]["nullable"] is True

    indexes = {ix["name"] for ix in inspector.get_indexes("diff_events")}
    assert "ix_diff_events_container_created" in indexes
