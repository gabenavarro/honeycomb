"""Artifact service tests (M35)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.models.schemas import AgentStatus, ContainerRecord, ContainerStatus, ProjectType
from hub.services.artifacts import (
    archive_artifact,
    delete_artifact,
    get_artifact,
    list_artifacts,
    pin_artifact,
    record_artifact,
    unpin_artifact,
)
from hub.services.diff_events import record_event


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
async def test_record_and_get_artifact(registered_container, registry_engine) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="My Note",
        body="Body text.",
        metadata={"source": "user"},
    )
    assert art.artifact_id  # populated
    assert art.type == "note"
    assert art.title == "My Note"
    assert art.body == "Body text."
    assert art.metadata == {"source": "user"}

    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched is not None
    assert fetched.artifact_id == art.artifact_id


@pytest.mark.asyncio
async def test_get_artifact_returns_none_for_unknown(registry_engine) -> None:
    assert await get_artifact(registry_engine, artifact_id="does-not-exist") is None


@pytest.mark.asyncio
async def test_list_artifacts_filters_by_container(registered_container, registry_engine) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    rows = await list_artifacts(registry_engine, container_id=registered_container.id)
    assert len(rows) == 1
    assert rows[0].title == "A"


@pytest.mark.asyncio
async def test_list_artifacts_filters_by_type(registered_container, registry_engine) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="plan",
        title="Plan A",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="Note A",
        body="...",
    )
    plans = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["plan"]
    )
    assert len(plans) == 1
    assert plans[0].type == "plan"


@pytest.mark.asyncio
async def test_list_artifacts_search_matches_title_and_body(
    registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="Refactor plan",
        body="lorem ipsum",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="Other",
        body="contains REFACTOR keyword",
    )
    matches = await list_artifacts(
        registry_engine, container_id=registered_container.id, search="refactor"
    )
    # Title hit + body hit; case-insensitive
    assert len(matches) == 2


@pytest.mark.asyncio
async def test_list_artifacts_excludes_archived_by_default(
    registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    await archive_artifact(registry_engine, artifact_id=art.artifact_id)
    rows = await list_artifacts(registry_engine, container_id=registered_container.id)
    assert len(rows) == 0
    rows_archived = await list_artifacts(
        registry_engine, container_id=registered_container.id, include_archived=True
    )
    assert len(rows_archived) == 1
    assert rows_archived[0].archived is True


@pytest.mark.asyncio
async def test_pin_unpin_archive_delete(registered_container, registry_engine) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )

    await pin_artifact(registry_engine, artifact_id=art.artifact_id)
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is True

    await unpin_artifact(registry_engine, artifact_id=art.artifact_id)
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is False

    await archive_artifact(registry_engine, artifact_id=art.artifact_id)
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.archived is True

    await delete_artifact(registry_engine, artifact_id=art.artifact_id)
    assert await get_artifact(registry_engine, artifact_id=art.artifact_id) is None


@pytest.mark.asyncio
async def test_list_artifacts_synthesizes_edits_from_diff_events(
    registered_container, registry_engine
) -> None:
    # Record a diff event via the M27 service
    frame = DiffEventFrame(
        container_id=str(registered_container.id),
        tool_use_id="tu-1",
        tool="Edit",
        path="src/foo.py",
        diff="--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        added_lines=1,
        removed_lines=1,
        timestamp=datetime.now().isoformat(),
    )
    diff = await record_event(registry_engine, container_id=registered_container.id, frame=frame)

    # list_artifacts (no filter) should include the synthesized edit
    rows = await list_artifacts(registry_engine, container_id=registered_container.id)
    edits = [r for r in rows if r.type == "edit"]
    assert len(edits) == 1
    assert edits[0].artifact_id == f"edit-{diff.event_id}"
    assert edits[0].body  # contains the diff
    assert edits[0].metadata is not None
    assert edits[0].metadata["paths"] == ["src/foo.py"]
    assert edits[0].metadata["lines_added"] == 1


@pytest.mark.asyncio
async def test_list_artifacts_type_filter_edits_only(registered_container, registry_engine) -> None:
    """Filtering by type=edit returns ONLY synthesized edits, not real rows."""
    # Real artifact (note) — should NOT appear
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="N",
        body="x",
    )
    # Diff event — should appear synthesized
    frame = DiffEventFrame(
        container_id=str(registered_container.id),
        tool_use_id="tu-2",
        tool="Write",
        path="src/bar.py",
        diff="--- /dev/null\n+++ b/src/bar.py\n@@ -0,0 +1,1 @@\n+new\n",
        added_lines=1,
        removed_lines=0,
        timestamp=datetime.now().isoformat(),
    )
    await record_event(registry_engine, container_id=registered_container.id, frame=frame)

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["edit"]
    )
    assert len(rows) == 1
    assert rows[0].type == "edit"
