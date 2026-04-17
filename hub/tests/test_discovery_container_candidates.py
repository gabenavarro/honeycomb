"""Tests for ``scan_container_candidates`` — running + non-running surfacing.

Before the fix this helper filtered ``status: running`` and hid stopped
containers entirely, which confused users whose containers showed as
green in Docker Desktop (that UI's green dot means "image in use", not
"container running"). The fix widens the query to include
exited/created/paused/restarting, sorts running-first, and leaves the
register flow to write ``container_status=stopped`` when appropriate.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hub.services.discovery import scan_container_candidates


class _FakeImage:
    def __init__(self, tag: str) -> None:
        self.tags = [tag]
        self.id = tag


def _fake_container(
    *,
    short_id: str,
    name: str,
    status: str,
    tag: str = "alpine:latest",
    labels: dict | None = None,
    mounts: list | None = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        short_id=short_id,
        name=name,
        status=status,
        image=_FakeImage(tag),
        labels=labels or {},
        attrs={"Mounts": mounts or []},
    )


class _FakeContainers:
    def __init__(self, containers: list[SimpleNamespace]) -> None:
        self._containers = containers

    def list(self, *, all: bool = False, filters: dict | None = None):
        # Honour ``all=True`` contract: return every container regardless
        # of status. Tests pin the status filter explicitly when needed.
        return list(self._containers)


class _FakeClient:
    def __init__(self, containers: list[SimpleNamespace]) -> None:
        self.containers = _FakeContainers(containers)


@pytest.mark.asyncio
async def test_running_containers_returned_first() -> None:
    containers = [
        _fake_container(short_id="aaa", name="stopped-one", status="exited"),
        _fake_container(short_id="bbb", name="running-one", status="running"),
    ]
    with patch("hub.services.discovery.docker.from_env", return_value=_FakeClient(containers)):
        result = await scan_container_candidates(registered_container_ids=set())

    assert [c.container_id for c in result] == ["bbb", "aaa"]
    assert [c.status for c in result] == ["running", "exited"]


@pytest.mark.asyncio
async def test_stopped_containers_are_surfaced() -> None:
    """Regression: the Discover tab must show stopped containers so the
    user isn't silently missing them when Docker Desktop's "in use" dot
    implies otherwise."""
    containers = [
        _fake_container(short_id="c1", name="exp-a", status="exited"),
        _fake_container(short_id="c2", name="exp-b", status="created"),
    ]
    with patch("hub.services.discovery.docker.from_env", return_value=_FakeClient(containers)):
        result = await scan_container_candidates(registered_container_ids=set())

    assert {c.container_id for c in result} == {"c1", "c2"}


@pytest.mark.asyncio
async def test_dead_containers_are_excluded() -> None:
    """Dead + removing are noisy and not registrable — skip them."""
    containers = [
        _fake_container(short_id="x", name="alive", status="running"),
        _fake_container(short_id="y", name="dead", status="dead"),
        _fake_container(short_id="z", name="gone", status="removing"),
    ]
    with patch("hub.services.discovery.docker.from_env", return_value=_FakeClient(containers)):
        result = await scan_container_candidates(registered_container_ids=set())

    assert [c.container_id for c in result] == ["x"]


@pytest.mark.asyncio
async def test_registered_containers_are_filtered_out() -> None:
    containers = [
        _fake_container(short_id="taken", name="already-here", status="running"),
        _fake_container(short_id="free", name="open", status="exited"),
    ]
    with patch("hub.services.discovery.docker.from_env", return_value=_FakeClient(containers)):
        result = await scan_container_candidates(registered_container_ids={"taken"})

    assert [c.container_id for c in result] == ["free"]
