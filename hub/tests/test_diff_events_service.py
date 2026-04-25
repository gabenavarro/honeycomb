"""Unit tests for the diff_events service layer (M27)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import create_async_engine

from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.services.diff_events import list_events, record_event


@pytest_asyncio.fixture
async def engine(tmp_path: Path):
    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    eng = create_async_engine(f"sqlite+aiosqlite:///{db_path}")

    @sa.event.listens_for(eng.sync_engine, "connect")
    def _fk_on(conn, _r):
        conn.execute("PRAGMA foreign_keys=ON")

    async with eng.begin() as conn:
        await conn.execute(
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

    yield eng
    await eng.dispose()


def _frame(path: str = "/workspace/x.py", added: int = 1, removed: int = 0) -> DiffEventFrame:
    return DiffEventFrame(
        container_id="c-1",
        tool_use_id="toolu_test",
        claude_session_id=None,
        tool="Edit",
        path=path,
        diff="--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n",
        added_lines=added,
        removed_lines=removed,
        timestamp="2026-04-23T07:38:00Z",
    )


@pytest.mark.asyncio
async def test_record_event_returns_populated_row(engine) -> None:
    event = await record_event(engine, container_id=1, frame=_frame())
    assert len(event.event_id) == 32
    assert event.container_id == 1
    assert event.tool == "Edit"
    assert event.path == "/workspace/x.py"
    assert event.added_lines == 1
    assert event.size_bytes > 0


@pytest.mark.asyncio
async def test_list_events_empty_by_default(engine) -> None:
    assert await list_events(engine, container_id=1) == []


@pytest.mark.asyncio
async def test_list_events_newest_first(engine) -> None:
    a = await record_event(engine, container_id=1, frame=_frame(path="/a"))
    b = await record_event(engine, container_id=1, frame=_frame(path="/b"))
    c = await record_event(engine, container_id=1, frame=_frame(path="/c"))
    events = await list_events(engine, container_id=1)
    assert [e.event_id for e in events] == [c.event_id, b.event_id, a.event_id]


@pytest.mark.asyncio
async def test_record_event_evicts_oldest_beyond_200(engine) -> None:
    """Insert 205 events; only the 200 most recent survive."""
    for i in range(205):
        await record_event(engine, container_id=1, frame=_frame(path=f"/p{i}"))
    events = await list_events(engine, container_id=1)
    assert len(events) == 200
    paths = {e.path for e in events}
    for i in range(5):
        assert f"/p{i}" not in paths
    for i in range(5, 205):
        assert f"/p{i}" in paths


@pytest.mark.asyncio
async def test_cascade_on_container_delete(engine) -> None:
    await record_event(engine, container_id=1, frame=_frame())
    async with engine.begin() as conn:
        await conn.execute(sa.text("DELETE FROM containers WHERE id = 1"))
    assert await list_events(engine, container_id=1) == []
