"""Tests for the hub API endpoints."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from hub.main import app
from hub.services.registry import Registry


@pytest_asyncio.fixture
async def registry(tmp_path):
    db_path = tmp_path / "test.db"
    reg = Registry(db_path=db_path)
    await reg.open()
    yield reg
    await reg.close()


@pytest_asyncio.fixture
async def client(registry):
    """Set up app state with a test registry and return a TestClient."""
    app.state.registry = registry
    app.state.devcontainer_mgr = MagicMock()
    app.state.claude_relay = MagicMock()
    app.state.resource_monitor = MagicMock()
    app.state.resource_monitor.get_stats = MagicMock(return_value=None)
    from hub.services.health_checker import HealthChecker

    app.state.health_checker = HealthChecker(registry)
    return TestClient(app, raise_server_exceptions=False)


class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health(self, client: TestClient) -> None:
        resp = client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["version"] == "0.1.0"


class TestHeartbeatEndpoint:
    @pytest.mark.asyncio
    async def test_heartbeat(self, client: TestClient) -> None:
        resp = client.post(
            "/api/heartbeat",
            json={
                "container_id": "test-container",
                "status": "idle",
                "agent_port": 9100,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


class TestEventEndpoint:
    @pytest.mark.asyncio
    async def test_event(self, client: TestClient) -> None:
        resp = client.post(
            "/api/events",
            json={
                "container_id": "test-container",
                "event_type": "command_completed",
                "data": {"exit_code": 0},
            },
        )
        assert resp.status_code == 200
        assert resp.json()["ok"] is True


class TestContainersEndpoint:
    @pytest.mark.asyncio
    async def test_list_empty(self, client: TestClient) -> None:
        resp = client.get("/api/containers")
        assert resp.status_code == 200
        assert resp.json() == []

    @pytest.mark.asyncio
    async def test_create_no_autostart(self, client: TestClient) -> None:
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/project",
                "project_name": "Test Project",
                "project_type": "base",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["project_name"] == "Test Project"
        assert data["workspace_folder"] == "/test/project"

    @pytest.mark.asyncio
    async def test_list_after_create(self, client: TestClient) -> None:
        client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/a",
                "project_name": "A",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/b",
                "project_name": "B",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        resp = client.get("/api/containers")
        assert len(resp.json()) == 2

    @pytest.mark.asyncio
    async def test_get_container(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/get",
                "project_name": "Get Test",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = create_resp.json()["id"]
        resp = client.get(f"/api/containers/{record_id}")
        assert resp.status_code == 200
        assert resp.json()["project_name"] == "Get Test"

    @pytest.mark.asyncio
    async def test_get_nonexistent(self, client: TestClient) -> None:
        resp = client.get("/api/containers/999")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_delete_container(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/delete",
                "project_name": "Delete Me",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        record_id = create_resp.json()["id"]
        resp = client.delete(f"/api/containers/{record_id}")
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True

        resp = client.get(f"/api/containers/{record_id}")
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_duplicate_workspace_rejected(self, client: TestClient) -> None:
        client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/dup",
                "project_name": "First",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        resp = client.post(
            "/api/containers",
            json={
                "workspace_folder": "/test/dup",
                "project_name": "Second",
                "auto_provision": False,
                "auto_start": False,
            },
        )
        assert resp.status_code == 409
