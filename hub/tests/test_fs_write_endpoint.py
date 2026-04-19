"""Integration tests for PUT /api/containers/{id}/fs/write (M24)."""

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


def _docker_with(
    monkeypatch, *, stat_responses: list, put_archive_result: bool = True
) -> MagicMock:
    """Swap ``docker.from_env`` to return a client whose container
    returns the given stat responses in order and the given
    put_archive result."""
    import docker

    container = MagicMock()
    container.exec_run = MagicMock(side_effect=stat_responses)
    container.put_archive = MagicMock(return_value=put_archive_result)
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container)
    monkeypatch.setattr(docker, "from_env", lambda: client)
    return container


@pytest.mark.asyncio
async def test_write_happy_path_text(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[
            (0, b"100|1700000000.000000000"),
            (0, b"644|0|0"),
            (0, b"12|1700000100.000000000"),
            # fs.py re-sniffs MIME via `file --mime-type` on the write
            # response; return a text/* so the content branch fires.
            (0, b"text/plain"),
        ],
    )
    registry = _FakeRegistry(_FakeRecord())
    body = {
        "path": "/w/foo.txt",
        "content": "hello world\n",
        "if_match_mtime_ns": 1_700_000_000_000_000_000,
    }
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json=body,
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    b = resp.json()
    assert b["path"] == "/w/foo.txt"
    assert b["mtime_ns"] == 1_700_000_100_000_000_000
    assert b["size_bytes"] == 12
    assert b["content"] == "hello world\n"


@pytest.mark.asyncio
async def test_write_base64_round_trip(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[
            (0, b"5|1700000000.000000000"),
            (0, b"644|0|0"),
            (0, b"5|1700000100.000000000"),
            # MIME sniff — anything non-text so the base64 echo branch
            # fires.
            (0, b"application/octet-stream"),
        ],
    )
    registry = _FakeRegistry(_FakeRecord())
    body = {
        "path": "/w/a.bin",
        "content_base64": "aGVsbG8=",
        "if_match_mtime_ns": 1_700_000_000_000_000_000,
    }
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json=body,
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json()["content_base64"] == "aGVsbG8="


@pytest.mark.asyncio
async def test_write_unauthorized() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "if_match_mtime_ns": 0,
            },
        )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_write_rejects_bad_path(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": ";rm -rf /",
                "content": "x",
                "if_match_mtime_ns": 0,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_write_rejects_both_content_fields(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "content_base64": "aGVsbG8=",
                "if_match_mtime_ns": 0,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_write_rejects_neither_content_field(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={"path": "/w/foo", "if_match_mtime_ns": 0},
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_write_404_on_missing_file(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[(1, b"stat: cannot stat '/nope': No such file or directory\n")],
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/nope",
                "content": "x",
                "if_match_mtime_ns": 0,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_write_409_on_mtime_mismatch(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[(0, b"100|1700000500.000000000")],
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "if_match_mtime_ns": 1_700_000_000_000_000_000,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 409
    body = resp.json()
    # FastAPI wraps HTTPException(detail={...}) so the body is
    # {"detail": {"detail": "File changed on disk", "current_mtime_ns": ...}}
    # OR directly {"detail": "...", "current_mtime_ns": ...} depending on
    # how we raise. Accept either — the test inspects the nested form.
    if "current_mtime_ns" in body:
        assert body["current_mtime_ns"] == 1_700_000_500_000_000_000
    else:
        assert body["detail"]["current_mtime_ns"] == 1_700_000_500_000_000_000


@pytest.mark.asyncio
async def test_write_413_on_oversize(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    body = {
        "path": "/w/big",
        "content": "x" * (5 * 1024 * 1024 + 1),
        "if_match_mtime_ns": 0,
    }
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json=body,
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_write_502_on_put_archive_failure(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[
            (0, b"100|1700000000.000000000"),
            (0, b"644|0|0"),
        ],
        put_archive_result=False,
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "if_match_mtime_ns": 1_700_000_000_000_000_000,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 502
