"""Tests for the agent-WS DiffEventFrame intake (M27).

Mocks the module-level ``ws_router.manager`` (the ConnectionManager
singleton broadcasts go through) using the same monkeypatch pattern
M30 introduced for sessions. Asserts the frame is recorded AND
broadcast on ``diff-events:<container_id>``."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
import sqlalchemy as sa

from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.services.diff_events import list_events


@pytest_asyncio.fixture
async def setup(tmp_path: Path, monkeypatch):
    from hub.routers import agent as agent_router
    from hub.services.registry import Registry

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    sync = sa.create_engine(f"sqlite:///{db_path}")
    with sync.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO containers "
                "(id, workspace_folder, project_type, project_name, "
                "project_description, container_status, agent_status, "
                "agent_port, has_gpu, has_claude_cli, agent_expected, "
                "created_at, updated_at) "
                "VALUES (42, '/w','base','demo','','running','idle',0,0,0,1,"
                "'2026-04-20T00:00:00','2026-04-20T00:00:00')",
            ),
        )

    reg = Registry(db_path=db_path)
    await reg.open()

    mock_mgr = MagicMock()
    mock_mgr.broadcast = AsyncMock()
    monkeypatch.setattr(agent_router.ws_router, "manager", mock_mgr)

    yield reg, mock_mgr, agent_router
    await reg.close()


@pytest.mark.asyncio
async def test_diff_event_frame_records_and_broadcasts(setup) -> None:
    reg, mock_mgr, agent_router = setup
    frame = DiffEventFrame(
        container_id="c-42",
        tool_use_id="toolu_1",
        tool="Edit",
        path="/workspace/foo.py",
        diff="--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        added_lines=1,
        removed_lines=1,
        timestamp="2026-04-23T07:38:00Z",
    )

    await agent_router._broadcast_diff_event(reg.engine, container_id=42, frame=frame)

    rows = await list_events(reg.engine, container_id=42)
    assert len(rows) == 1
    assert rows[0].path == "/workspace/foo.py"

    assert mock_mgr.broadcast.await_count == 1
    sent = mock_mgr.broadcast.await_args.args[0]
    assert sent.channel == "diff-events:42"
    assert sent.event == "new"
    assert sent.data["path"] == "/workspace/foo.py"
    assert sent.data["event_id"] == rows[0].event_id


@pytest.mark.asyncio
async def test_broadcast_failure_does_not_raise(setup) -> None:
    reg, mock_mgr, agent_router = setup
    mock_mgr.broadcast.side_effect = RuntimeError("ws boom")

    frame = DiffEventFrame(
        container_id="c-42",
        tool_use_id="toolu_2",
        tool="Write",
        path="/workspace/bar.py",
        diff="+++ b/bar.py\n",
        added_lines=1,
        removed_lines=0,
        timestamp="2026-04-23T07:38:01Z",
    )

    # Helper must catch + log; the row still lands.
    await agent_router._broadcast_diff_event(reg.engine, container_id=42, frame=frame)
    rows = await list_events(reg.engine, container_id=42)
    assert len(rows) == 1
