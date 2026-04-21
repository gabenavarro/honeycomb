"""Integration tests for the named-sessions router (M26)."""

from __future__ import annotations

from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.db.migrations_runner import apply_migrations_sync


@pytest_asyncio.fixture
async def client(tmp_path: Path):
    from hub.main import app
    from hub.services.registry import Registry

    db_path = tmp_path / "registry.db"
    apply_migrations_sync(db_path)
    # Seed a container. Column list mirrors the M26 Task 3 pattern.
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
        yield c

    await reg.close()


AUTH = {"Authorization": "Bearer test-token"}


@pytest.mark.asyncio
async def test_list_empty_container(client: AsyncClient) -> None:
    resp = await client.get("/api/containers/1/named-sessions", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_create_and_list_round_trip(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "Main", "kind": "shell"},
    )
    assert resp.status_code == 200
    created = resp.json()
    assert created["name"] == "Main"
    assert created["kind"] == "shell"
    assert created["container_id"] == 1
    assert len(created["session_id"]) == 32

    resp = await client.get("/api/containers/1/named-sessions", headers=AUTH)
    assert resp.status_code == 200
    listed = resp.json()
    assert len(listed) == 1
    assert listed[0]["session_id"] == created["session_id"]


@pytest.mark.asyncio
async def test_patch_renames(client: AsyncClient) -> None:
    create = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "orig"},
    )
    sid = create.json()["session_id"]
    resp = await client.patch(
        f"/api/named-sessions/{sid}",
        headers=AUTH,
        json={"name": "renamed"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "renamed"


@pytest.mark.asyncio
async def test_delete_removes_row(client: AsyncClient) -> None:
    create = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "bye"},
    )
    sid = create.json()["session_id"]
    resp = await client.delete(f"/api/named-sessions/{sid}", headers=AUTH)
    assert resp.status_code == 204
    listed = await client.get("/api/containers/1/named-sessions", headers=AUTH)
    assert listed.json() == []


@pytest.mark.asyncio
async def test_delete_missing_is_idempotent(client: AsyncClient) -> None:
    resp = await client.delete("/api/named-sessions/nope", headers=AUTH)
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_unauthorized_list() -> None:
    # No Authorization header → 401 regardless of path.
    from hub.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.get("/api/containers/1/named-sessions")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_create_404_unknown_container(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/999/named-sessions",
        headers=AUTH,
        json={"name": "x"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_patch_404_unknown_session(client: AsyncClient) -> None:
    resp = await client.patch(
        "/api/named-sessions/nope",
        headers=AUTH,
        json={"name": "x"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_422_on_empty_name(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": ""},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_422_on_long_name(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "a" * 65},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_422_on_bad_kind(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/containers/1/named-sessions",
        headers=AUTH,
        json={"name": "x", "kind": "weird"},
    )
    assert resp.status_code == 422
