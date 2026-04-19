"""M24 — verify the read endpoint echoes mtime_ns."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings


class _FakeRecord:
    def __init__(self) -> None:
        self.container_id = "deadbeef"


class _FakeRegistry:
    async def get(self, record_id: int) -> _FakeRecord:
        return _FakeRecord()


async def _client() -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = _FakeRegistry()
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_read_echoes_mtime_ns(monkeypatch) -> None:
    import docker

    container = MagicMock()
    # stat -c '%s|%Y.%N' → size|secs.nanos
    container.exec_run = MagicMock(
        side_effect=[
            (0, b"5|1700000000.123456789"),
            # file --mime-type
            (0, b"text/plain"),
            # cat
            (0, b"hello"),
        ],
    )
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container)
    monkeypatch.setattr(docker, "from_env", lambda: client)

    async with await _client() as c:
        resp = await c.get(
            "/api/containers/1/fs/read?path=/workspace/foo.txt",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mtime_ns"] == 1_700_000_000_123_456_789
    assert body["size_bytes"] == 5
    assert body["content"] == "hello"
