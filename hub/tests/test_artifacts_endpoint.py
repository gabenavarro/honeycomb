"""Endpoint tests for the artifacts router (M35)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from hub.config import HiveSettings
from hub.db.migrations_runner import apply_migrations_sync
from hub.models.schemas import AgentStatus, ContainerRecord, ContainerStatus, ProjectType
from hub.services.artifacts import get_artifact, record_artifact

AUTH = {"Authorization": "Bearer test-token"}


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


@pytest_asyncio.fixture
async def client(registry_engine, registered_container, tmp_path: Path):
    from hub.main import app
    from hub.services.registry import Registry

    # Retrieve the DB path from the engine URL
    db_url = str(registry_engine.url)
    db_path = Path(db_url.replace("sqlite+aiosqlite:///", ""))

    reg = Registry(db_path=db_path)
    await reg.open()

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = reg

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c

    await reg.close()


@pytest.mark.asyncio
async def test_list_artifacts_empty(client: AsyncClient, registered_container) -> None:
    resp = await client.get(f"/api/containers/{registered_container.id}/artifacts", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_artifacts_returns_recorded(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="hello",
    )
    resp = await client.get(f"/api/containers/{registered_container.id}/artifacts", headers=AUTH)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["artifact_id"] == art.artifact_id
    assert body[0]["title"] == "A"


@pytest.mark.asyncio
async def test_list_artifacts_filters_by_type_query_param(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="plan",
        title="P",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="N",
        body="...",
    )
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts?type=plan",
        headers=AUTH,
    )
    body = resp.json()
    assert len(body) == 1
    assert body[0]["type"] == "plan"


@pytest.mark.asyncio
async def test_list_artifacts_supports_multi_type_filter(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="plan",
        title="P",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="N",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="snippet",
        title="S",
        body="...",
    )
    # Repeated query param: ?type=plan&type=note
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts?type=plan&type=note",
        headers=AUTH,
    )
    body = resp.json()
    types = sorted(b["type"] for b in body)
    assert types == ["note", "plan"]


@pytest.mark.asyncio
async def test_list_artifacts_search_matches_body(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="lorem ipsum",
    )
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts?search=ipsum",
        headers=AUTH,
    )
    assert len(resp.json()) == 1


@pytest.mark.asyncio
async def test_get_artifact_404_on_unknown(client: AsyncClient) -> None:
    resp = await client.get("/api/artifacts/does-not-exist", headers=AUTH)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_artifact_returns_detail(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="x",
    )
    resp = await client.get(f"/api/artifacts/{art.artifact_id}", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["artifact_id"] == art.artifact_id


@pytest.mark.asyncio
async def test_create_artifact_endpoint(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    resp = await client.post(
        f"/api/containers/{registered_container.id}/artifacts",
        json={"type": "note", "title": "New Note", "body": "hello"},
        headers=AUTH,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["type"] == "note"
    assert body["title"] == "New Note"
    assert body["body"] == "hello"
    assert body["body_format"] == "markdown"
    # Verify it landed in the DB
    fetched = await get_artifact(registry_engine, artifact_id=body["artifact_id"])
    assert fetched is not None


@pytest.mark.asyncio
async def test_create_artifact_rejects_invalid_type(
    client: AsyncClient, registered_container
) -> None:
    resp = await client.post(
        f"/api/containers/{registered_container.id}/artifacts",
        json={"type": "bogus", "title": "X", "body": "y"},
        headers=AUTH,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_pin_unpin_archive_endpoints(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    # Pin
    resp = await client.post(f"/api/artifacts/{art.artifact_id}/pin", headers=AUTH)
    assert resp.status_code == 204
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is True
    # Unpin
    resp = await client.post(f"/api/artifacts/{art.artifact_id}/unpin", headers=AUTH)
    assert resp.status_code == 204
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is False
    # Archive
    resp = await client.post(f"/api/artifacts/{art.artifact_id}/archive", headers=AUTH)
    assert resp.status_code == 204
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.archived is True


@pytest.mark.asyncio
async def test_delete_artifact_endpoint(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    resp = await client.delete(f"/api/artifacts/{art.artifact_id}", headers=AUTH)
    assert resp.status_code == 204
    assert await get_artifact(registry_engine, artifact_id=art.artifact_id) is None


@pytest.mark.asyncio
async def test_pin_unknown_artifact_is_idempotent_204(client: AsyncClient) -> None:
    """Mutators silently no-op on unknown IDs (idempotent contract)."""
    resp = await client.post("/api/artifacts/never-existed/pin", headers=AUTH)
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_archive_synthesized_edit_id_is_silent_204(
    client: AsyncClient,
) -> None:
    """Mutators on 'edit-*' synthesized IDs no-op silently (no DB write)."""
    resp = await client.post("/api/artifacts/edit-abc123/archive", headers=AUTH)
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_create_artifact_broadcasts_new(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    from unittest.mock import AsyncMock, patch

    from hub.routers.ws import manager as ws_mgr

    with patch.object(ws_mgr, "broadcast", new=AsyncMock()) as mock_broadcast:
        resp = await client.post(
            f"/api/containers/{registered_container.id}/artifacts",
            json={"type": "note", "title": "N", "body": "x"},
            headers=AUTH,
        )
        assert resp.status_code == 201
        calls = mock_broadcast.await_args_list
        channels = [c.args[0].channel for c in calls]
        assert f"library:{registered_container.id}" in channels


@pytest.mark.asyncio
async def test_delete_broadcasts_deleted(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    from unittest.mock import AsyncMock, patch

    from hub.routers.ws import manager as ws_mgr

    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    with patch.object(ws_mgr, "broadcast", new=AsyncMock()) as mock_broadcast:
        resp = await client.delete(f"/api/artifacts/{art.artifact_id}", headers=AUTH)
        assert resp.status_code == 204
        deleted_frames = [
            c.args[0] for c in mock_broadcast.await_args_list if c.args[0].event == "deleted"
        ]
        assert len(deleted_frames) == 1
        assert deleted_frames[0].channel == f"library:{registered_container.id}"


@pytest.mark.asyncio
async def test_pin_broadcasts_updated(
    client: AsyncClient, registered_container, registry_engine
) -> None:
    from unittest.mock import AsyncMock, patch

    from hub.routers.ws import manager as ws_mgr

    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    with patch.object(ws_mgr, "broadcast", new=AsyncMock()) as mock_broadcast:
        resp = await client.post(f"/api/artifacts/{art.artifact_id}/pin", headers=AUTH)
        assert resp.status_code == 204
        updated_frames = [
            c.args[0] for c in mock_broadcast.await_args_list if c.args[0].event == "updated"
        ]
        assert len(updated_frames) == 1
