"""M7 regressions: migration runner, update allowlist, legacy backup."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio

from hub.db.migrations_runner import run_migrations
from hub.services.registry import (
    ALLOWED_UPDATE_FIELDS,
    Registry,
)


@pytest_asyncio.fixture
async def registry(tmp_path: Path):
    reg = Registry(db_path=tmp_path / "test_registry_m7.db")
    await reg.open()
    yield reg
    await reg.close()


class TestUpdateAllowlist:
    @pytest.mark.asyncio
    async def test_unknown_column_raises_valueerror(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/m7-unknown",
            project_type="base",
            project_name="Demo",
        )
        with pytest.raises(ValueError) as exc:
            await registry.update(record.id, not_a_real_column="oops")
        msg = str(exc.value)
        assert "not_a_real_column" in msg
        assert "Allowed" in msg

    @pytest.mark.asyncio
    async def test_allowlist_is_the_expected_set(self) -> None:
        # If this test fails, a migration added or removed a column
        # and ALLOWED_UPDATE_FIELDS needs to be revised in lockstep.
        expected = {
            "project_type",
            "project_name",
            "project_description",
            "git_repo_url",
            "container_id",
            "container_status",
            "agent_status",
            "agent_expected",
            "agent_port",
            "has_gpu",
            "has_claude_cli",
            "claude_cli_checked_at",
        }
        assert set(ALLOWED_UPDATE_FIELDS) == expected

    @pytest.mark.asyncio
    async def test_immutable_columns_are_not_in_allowlist(self) -> None:
        for immutable in ("id", "workspace_folder", "created_at", "updated_at"):
            assert immutable not in ALLOWED_UPDATE_FIELDS

    @pytest.mark.asyncio
    async def test_allowed_update_still_writes(self, registry: Registry) -> None:
        record = await registry.add(
            workspace_folder="/m7-allow",
            project_type="base",
            project_name="Demo",
        )
        updated = await registry.update(record.id, project_name="Renamed")
        assert updated.project_name == "Renamed"

    @pytest.mark.asyncio
    async def test_multi_field_update_with_one_unknown_fails_atomically(
        self, registry: Registry
    ) -> None:
        """Unknown-column rejection happens before any write — the good
        fields must not have landed by the time we raise."""
        record = await registry.add(
            workspace_folder="/m7-atomic",
            project_type="base",
            project_name="Original",
        )
        with pytest.raises(ValueError):
            await registry.update(
                record.id,
                project_name="Changed",
                nonsense_column="x",
            )
        unchanged = await registry.get(record.id)
        assert unchanged.project_name == "Original"


class TestMigrationRunner:
    def test_empty_db_creates_schema_at_head(self, tmp_path: Path) -> None:
        db_path = tmp_path / "fresh.db"
        run_migrations(db_path)
        # Alembic puts a row in alembic_version once migrations apply.
        with sqlite3.connect(db_path) as conn:
            tables = {
                row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        assert "containers" in tables
        assert "alembic_version" in tables

    def test_legacy_db_is_backed_up(self, tmp_path: Path) -> None:
        """A DB with ``containers`` but no ``alembic_version`` is
        pre-M7 — we back it up with a timestamp suffix and create a
        fresh one at the original path."""
        db_path = tmp_path / "legacy.db"
        # Simulate the pre-M7 hand-rolled schema (no alembic_version row).
        with sqlite3.connect(db_path) as conn:
            conn.execute(
                "CREATE TABLE containers ("
                "id INTEGER PRIMARY KEY, workspace_folder TEXT UNIQUE NOT NULL"
                ")"
            )
            conn.execute("INSERT INTO containers (workspace_folder) VALUES ('/legacy-row')")

        run_migrations(db_path)

        # The original file is gone (renamed to a .bak-<timestamp>).
        backups = list(tmp_path.glob("legacy.db.bak-*"))
        assert len(backups) == 1, f"expected exactly one backup, got {backups}"

        # The new file is pristine — the legacy row is not there.
        with sqlite3.connect(db_path) as conn:
            rows = list(conn.execute("SELECT workspace_folder FROM containers"))
            tables = {
                row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        assert rows == []
        assert "alembic_version" in tables

    def test_already_managed_db_stays_put(self, tmp_path: Path) -> None:
        db_path = tmp_path / "managed.db"
        run_migrations(db_path)  # creates fresh + records alembic_version
        # Seed data that we want to survive a re-run.
        with sqlite3.connect(db_path) as conn:
            now = datetime.now().isoformat()
            conn.execute(
                "INSERT INTO containers "
                "(workspace_folder, project_name, created_at, updated_at) "
                "VALUES (?, ?, ?, ?)",
                ("/survives", "Persistent", now, now),
            )
            conn.commit()

        run_migrations(db_path)

        # No backups should have been created.
        assert list(tmp_path.glob("managed.db.bak-*")) == []
        with sqlite3.connect(db_path) as conn:
            rows = list(conn.execute("SELECT workspace_folder, project_name FROM containers"))
        assert rows == [("/survives", "Persistent")]
