"""Tests for the ProblemLog ring buffer (M10)."""

from __future__ import annotations

import asyncio

import pytest

from hub.services.problem_log import ProblemLog


def test_record_appends_in_order() -> None:
    log = ProblemLog()
    log.record("warning", "health", "first")
    log.record("error", "agent", "second")
    log.record("info", "relay", "third")

    items = log.list()
    assert [p.message for p in items] == ["first", "second", "third"]
    assert [p.id for p in items] == [1, 2, 3]


def test_capacity_evicts_oldest() -> None:
    log = ProblemLog(capacity=3)
    for i in range(5):
        log.record("info", "health", f"m{i}")

    items = log.list()
    assert len(items) == 3
    assert [p.message for p in items] == ["m2", "m3", "m4"]


def test_clear_empties_buffer_but_keeps_ids_incrementing() -> None:
    log = ProblemLog()
    log.record("warning", "health", "a")
    log.clear()
    p = log.record("error", "agent", "b")
    assert log.list() == [p]
    assert p.id == 2


def test_to_dict_is_json_serialisable() -> None:
    log = ProblemLog()
    p = log.record(
        "warning",
        "health",
        "unreachable",
        container_id="abc",
        project_name="demo",
    )
    d = p.to_dict()
    for key in (
        "id",
        "severity",
        "source",
        "message",
        "container_id",
        "project_name",
        "created_at",
    ):
        assert key in d


@pytest.mark.asyncio
async def test_broadcast_is_scheduled_when_loop_is_running() -> None:
    log = ProblemLog()
    received: list[str] = []

    async def sink(problem) -> None:
        received.append(problem.message)

    log.set_broadcast(sink)
    log.record("info", "health", "hello")

    # Let the scheduled task run.
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert received == ["hello"]


def test_record_without_running_loop_does_not_raise() -> None:
    """Smoke test: recording from a sync context skips the broadcast
    gracefully instead of raising."""
    log = ProblemLog()

    async def sink(problem) -> None:  # pragma: no cover — must not run
        raise AssertionError("should not be scheduled in sync context")

    log.set_broadcast(sink)
    log.record("info", "health", "sync")

    assert log.list()[0].message == "sync"
