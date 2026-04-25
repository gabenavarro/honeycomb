"""Integration tests for the diff_events GET endpoint (M27)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.db.migrations_runner import apply_migrations_sync
from hub.models.agent_protocol import DiffEventFrame
from hub.services.diff_events import record_event


@pytest_asyncio.fixture
async def client(tmp_path: Path):
    from hub.main import app
    from hub.services.registry import Registry

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
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

    reg = Registry(db_path=db_path)
    await reg.open()

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = reg

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c, reg

    await reg.close()


AUTH = {"Authorization": "Bearer test-token"}


def _frame(path: str = "/workspace/x.py") -> DiffEventFrame:
    return DiffEventFrame(
        container_id="c-1",
        tool_use_id="toolu_test",
        tool="Edit",
        path=path,
        diff="--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        added_lines=1,
        removed_lines=1,
        timestamp="2026-04-23T07:38:00Z",
    )


@pytest.mark.asyncio
async def test_list_empty_container(client) -> None:
    c, _reg = client
    resp = await c.get("/api/containers/1/diff-events", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_returns_newest_first(client) -> None:
    c, reg = client
    a = await record_event(reg.engine, container_id=1, frame=_frame(path="/a"))
    b = await record_event(reg.engine, container_id=1, frame=_frame(path="/b"))

    resp = await c.get("/api/containers/1/diff-events", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert [r["event_id"] for r in body] == [b.event_id, a.event_id]
    assert body[0]["path"] == "/b"


@pytest.mark.asyncio
async def test_list_404_unknown_container(client) -> None:
    c, _reg = client
    resp = await c.get("/api/containers/999/diff-events", headers=AUTH)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_unauthorized() -> None:
    from hub.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/api/containers/1/diff-events")
    assert resp.status_code == 401
