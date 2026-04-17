"""Integration tests for ``GET /api/containers/{id}/sessions`` (M16).

The endpoint is a read-only view over ``PtyRegistry.all()`` so we drive
the test by stubbing a tiny registry onto ``app.state`` rather than
spinning up a real docker exec socket — the PTY lifecycle itself is
covered by ``test_pty_session``.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings


class _FakeSession:
    """Shape-compatible with what ``sessions.list_sessions`` reads:
    ``.key`` = (record_id, session_id); ``.container_id``; ``.cols``,
    ``.rows``; ``._attached``; ``.seconds_since_detach()``."""

    def __init__(
        self,
        record_id: int,
        session_id: str,
        container_id: str = "abc123",
        attached: bool = False,
        detached_for_seconds: float | None = 12.0,
    ) -> None:
        self.key = (record_id, session_id)
        self.container_id = container_id
        self.cols = 80
        self.rows = 24
        self._attached = "reader" if attached else None

        def _fn() -> float | None:
            return detached_for_seconds

        self.seconds_since_detach = _fn


class _FakeRegistry:
    def __init__(self, sessions: list[_FakeSession]) -> None:
        self._sessions = sessions

    def all(self) -> list[_FakeSession]:
        return list(self._sessions)


async def _client(sessions: list[_FakeSession]) -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.pty_registry = _FakeRegistry(sessions)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_returns_only_sessions_for_the_requested_container() -> None:
    sessions = [
        _FakeSession(1, "default"),
        _FakeSession(1, "s-abc", attached=True, detached_for_seconds=None),
        _FakeSession(2, "default"),
    ]
    client = await _client(sessions)
    async with client:
        response = await client.get(
            "/api/containers/1/sessions",
            headers={"Authorization": "Bearer test-token"},
        )
    assert response.status_code == 200
    body = response.json()
    ids = [s["session_id"] for s in body["sessions"]]
    assert sorted(ids) == ["default", "s-abc"]


@pytest.mark.asyncio
async def test_empty_container_returns_empty_list() -> None:
    client = await _client([])
    async with client:
        response = await client.get(
            "/api/containers/9/sessions",
            headers={"Authorization": "Bearer test-token"},
        )
    assert response.status_code == 200
    assert response.json() == {"sessions": []}


@pytest.mark.asyncio
async def test_surfaces_attach_flag_and_detached_seconds() -> None:
    client = await _client(
        [
            _FakeSession(3, "live", attached=True, detached_for_seconds=None),
            _FakeSession(3, "idle", attached=False, detached_for_seconds=42.0),
        ],
    )
    async with client:
        response = await client.get(
            "/api/containers/3/sessions",
            headers={"Authorization": "Bearer test-token"},
        )
    body = response.json()
    by_id = {s["session_id"]: s for s in body["sessions"]}
    assert by_id["live"]["attached"] is True
    assert by_id["live"]["detached_for_seconds"] is None
    assert by_id["idle"]["attached"] is False
    assert by_id["idle"]["detached_for_seconds"] == 42.0
