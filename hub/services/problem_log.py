"""In-memory ring buffer of hub problems surfaced in the dashboard's
Problems panel (M10).

Each ``Problem`` is a small record — severity, source, container
context, message, timestamp. The log is append-only with a bounded
size; when full the oldest entry is evicted. This mirrors VSCode's
Problems panel contract: a non-persistent view that reflects what the
hub has seen *this session*.

The log is a singleton, attached to ``app.state.problem_log`` at
startup so any router or background service can report issues without
threading a reference through the constructor. The Problem stream is
also broadcast on the ``problems`` WebSocket channel so dashboards stay
in sync without polling.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

Severity = Literal["info", "warning", "error"]
Source = Literal["health", "agent", "relay", "registry", "other"]


@dataclass(frozen=True, slots=True)
class Problem:
    """A single problem entry. Keyed by ``id`` for stable list rendering."""

    id: int
    severity: Severity
    source: Source
    message: str
    container_id: str | None = None
    project_name: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "severity": self.severity,
            "source": self.source,
            "message": self.message,
            "container_id": self.container_id,
            "project_name": self.project_name,
            "created_at": self.created_at,
        }


class ProblemLog:
    """Bounded FIFO of ``Problem`` records with an optional async
    broadcast callback.

    Thread-safety: all mutation happens on the event loop; no lock is
    needed because ``deque`` operations are atomic and there are no
    compound read-modify-write paths. The broadcast callback, when set,
    is invoked via ``asyncio.create_task`` so callers don't block on
    slow subscribers.
    """

    DEFAULT_CAPACITY = 256

    BroadcastFn = Callable[["Problem"], Awaitable[None]]

    def __init__(self, capacity: int = DEFAULT_CAPACITY) -> None:
        self._items: deque[Problem] = deque(maxlen=capacity)
        self._next_id = 1
        self._broadcast: ProblemLog.BroadcastFn | None = None
        # Retain strong references to in-flight broadcast tasks so the
        # GC doesn't cancel them mid-flight (RUF006).
        self._broadcast_tasks: set[asyncio.Task[None]] = set()

    def set_broadcast(self, broadcast: ProblemLog.BroadcastFn) -> None:
        """Install a coroutine to be scheduled on every new problem.

        The callable is invoked as ``await broadcast(problem)``. Errors
        inside the callback are swallowed — a broken subscriber must
        never corrupt the log itself.
        """
        self._broadcast = broadcast

    def record(
        self,
        severity: Severity,
        source: Source,
        message: str,
        *,
        container_id: str | None = None,
        project_name: str | None = None,
    ) -> Problem:
        """Append a problem and return it. Safe to call from any code
        path; broadcasting is best-effort and scheduled, not awaited.
        """
        problem = Problem(
            id=self._next_id,
            severity=severity,
            source=source,
            message=message,
            container_id=container_id,
            project_name=project_name,
        )
        self._next_id += 1
        self._items.append(problem)
        if self._broadcast is not None:
            # No running loop means we're in a test or non-async caller;
            # broadcast is best-effort so silently skip.
            with contextlib.suppress(RuntimeError):
                loop = asyncio.get_running_loop()
                task = loop.create_task(self._safe_broadcast(problem))
                self._broadcast_tasks.add(task)
                task.add_done_callback(self._broadcast_tasks.discard)
        return problem

    async def _safe_broadcast(self, problem: Problem) -> None:
        if self._broadcast is None:
            return
        # Broadcast errors must never propagate out of the log.
        with contextlib.suppress(Exception):
            await self._broadcast(problem)

    def list(self) -> list[Problem]:
        """Return a snapshot of the current log, oldest-first."""
        return list(self._items)

    def clear(self) -> None:
        """Drop every entry. Ids continue counting up."""
        self._items.clear()
