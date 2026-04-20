"""Integration tests for GET /api/containers/{id}/resources/history (M25)."""

from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.models.schemas import ResourceStats


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


def _sample(cid: str = "deadbeef", cpu: float = 42.0) -> ResourceStats:
    return ResourceStats(
        container_id=cid,
        cpu_percent=cpu,
        memory_mb=100.0,
        memory_limit_mb=1024.0,
        memory_percent=10.0,
        timestamp=datetime.now(),
    )


async def _client(
    registry: _FakeRegistry,
    history_by_cid: dict[str, list[ResourceStats]] | None = None,
) -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = registry
    rm = MagicMock()
    rm.get_history = MagicMock(side_effect=lambda cid: (history_by_cid or {}).get(cid, []))
    app.state.resource_monitor = rm
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_history_empty_list_when_no_samples() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_history_returns_buffer() -> None:
    registry = _FakeRegistry(_FakeRecord("deadbeef"))
    history = {"deadbeef": [_sample(cpu=1.0), _sample(cpu=2.0), _sample(cpu=3.0)]}
    async with await _client(registry, history_by_cid=history) as c:
        resp = await c.get(
            "/api/containers/1/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 3
    assert [s["cpu_percent"] for s in body] == [1.0, 2.0, 3.0]


@pytest.mark.asyncio
async def test_history_unauthorized() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get("/api/containers/1/resources/history")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_history_404_on_unknown_record() -> None:
    registry = _FakeRegistry(None)
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/999/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_history_empty_when_record_has_no_docker_id() -> None:
    # A registered record that never started a container — container_id
    # is None. Return [] rather than 404.
    registry = _FakeRegistry(_FakeRecord(container_id=None))
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/resources/history",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json() == []
