"""Spec auto-save rescan (M35)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from hub.db.migrations_runner import apply_migrations_sync
from hub.models.schemas import AgentStatus, ContainerRecord, ContainerStatus, ProjectType
from hub.services.artifacts import (
    list_artifacts,
    rescan_spec_files,
)


@pytest_asyncio.fixture
async def registry_engine(tmp_path: Path):
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    # Seed a container row so artifacts can FK to it.
    sync_engine = sa.create_engine(f"sqlite:///{db_path}")
    with sync_engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES ('/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-20T00:00:00','2026-04-20T00:00:00')",
            ),
        )
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
    yield eng
    await eng.dispose()


@pytest.fixture
def registered_container() -> ContainerRecord:
    """Minimal ContainerRecord mirroring the seeded row in registry_engine."""
    ts = datetime.fromisoformat("2026-04-20T00:00:00")
    return ContainerRecord(
        id=1,
        workspace_folder="/w",
        project_type=ProjectType.BASE,
        project_name="demo",
        project_description="",
        container_status=ContainerStatus.RUNNING,
        agent_status=AgentStatus.IDLE,
        created_at=ts,
        updated_at=ts,
    )


@pytest.mark.asyncio
async def test_rescan_records_new_spec_files(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    spec_dir = tmp_path / "specs"
    spec_dir.mkdir()
    (spec_dir / "first.md").write_text("# First spec\n\nBody.")
    (spec_dir / "second.md").write_text("# Second\n\nMore body.")

    await rescan_spec_files(
        registry_engine,
        container_id=registered_container.id,
        specs_dir=spec_dir,
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    assert len(rows) == 2
    titles = sorted(r.title for r in rows)
    assert titles == ["First spec", "Second"]


@pytest.mark.asyncio
async def test_rescan_idempotent_does_not_duplicate(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    spec_dir = tmp_path / "specs"
    spec_dir.mkdir()
    (spec_dir / "x.md").write_text("# X\n\nBody.")

    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )
    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_rescan_picks_up_new_files_on_subsequent_run(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    spec_dir = tmp_path / "specs"
    spec_dir.mkdir()
    (spec_dir / "old.md").write_text("# Old\n\nOld body.")
    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )

    (spec_dir / "new.md").write_text("# New\n\nNew body.")
    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    titles = sorted(r.title for r in rows)
    assert titles == ["New", "Old"]


@pytest.mark.asyncio
async def test_rescan_handles_missing_directory(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    """Specs dir doesn't exist — rescan should silently no-op (0 records)."""
    await rescan_spec_files(
        registry_engine,
        container_id=registered_container.id,
        specs_dir=tmp_path / "does-not-exist",
    )
    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    assert rows == []
