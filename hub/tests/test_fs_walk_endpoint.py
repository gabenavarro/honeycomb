"""Integration tests for GET /api/containers/{id}/fs/walk (M23).

Follows the test_sessions_endpoint.py pattern: stub only what the
route reads off ``app.state`` + the docker client so we don't spin
up a real container.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings


class _FakeRecord:
    def __init__(self, container_id: str | None = "deadbeef") -> None:
        self.container_id = container_id


class _FakeRegistry:
    def __init__(self, record: _FakeRecord | None) -> None:
        self._record = record

    async def get(self, record_id: int) -> _FakeRecord:
        if self._record is None:
            raise KeyError(record_id)
        return self._record


async def _client(registry: _FakeRegistry) -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = registry
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _patch_docker(monkeypatch, *, exit_code: int, output: bytes) -> MagicMock:
    """Swap `docker.from_env()` to return a client whose
    ``containers.get(...).exec_run`` returns the given (code, bytes)."""
    import docker

    container = MagicMock()
    container.exec_run = MagicMock(return_value=(exit_code, output))
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container)
    monkeypatch.setattr(docker, "from_env", lambda: client)
    return container


@pytest.mark.asyncio
async def test_walk_happy_path(monkeypatch) -> None:
    _patch_docker(
        monkeypatch,
        exit_code=0,
        output=b"d\t4096\tsrc\nf\t10\tREADME.md\n",
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk?root=/workspace",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["root"] == "/workspace"
    assert [e["name"] for e in body["entries"]] == [
        "/workspace/src",
        "/workspace/README.md",
    ]
    assert body["truncated"] is False
    assert body["elapsed_ms"] >= 0


@pytest.mark.asyncio
async def test_walk_unauthorized_without_token() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get("/api/containers/1/fs/walk?root=/w")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_walk_rejects_bad_path(monkeypatch) -> None:
    _patch_docker(monkeypatch, exit_code=0, output=b"")
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk?root=;rm%20-rf%20/",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_walk_rejects_missing_container() -> None:
    registry = _FakeRegistry(None)
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/999/fs/walk?root=/w",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_walk_surfaces_find_failure(monkeypatch) -> None:
    _patch_docker(
        monkeypatch,
        exit_code=2,
        output=b"find: /nope: No such file or directory\n",
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk?root=/nope",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 502
    assert "No such file or directory" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_walk_uses_workdir_when_root_missing(monkeypatch) -> None:
    container = _patch_docker(monkeypatch, exit_code=0, output=b"")
    # When root is omitted, the route falls back to the container's
    # Config.WorkingDir.
    import docker

    container_with_attrs = MagicMock()
    container_with_attrs.attrs = {"Config": {"WorkingDir": "/app"}}
    container_with_attrs.exec_run = container.exec_run
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container_with_attrs)
    monkeypatch.setattr(docker, "from_env", lambda: client)

    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json()["root"] == "/app"
