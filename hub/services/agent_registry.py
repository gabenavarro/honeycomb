"""In-memory registry of live agent WebSocket connections.

Each running container with a hive-agent that successfully reached the
hub gets one entry here. The entry owns:

* the raw :class:`fastapi.WebSocket` used to push frames,
* a futures map indexed by ``command_id`` so the commands relay can
  await a ``done`` frame,
* per-command ``asyncio.Queue`` streams that surface ``output`` frames
  to any listener (the current command relay forwards them to the
  per-command WebSocket channel ``cmd:<id>``).

This registry is the *primary* command-dispatch path for the hub since
M4. When the socket is absent or unhealthy, the commands router falls
back to ``devcontainer exec`` and ``docker exec`` as before.

Concurrency
-----------
All mutation is serialised behind a small ``asyncio.Lock`` because the
same socket is touched from multiple coroutines (the reader loop in the
WS handler, and command-dispatch callers on the REST side). Sends are
already serialised by Starlette's ``WebSocket.send_json`` — but we hold
the lock while allocating futures so a cmd_exec dispatch cannot race
with a concurrent kill for the same command_id.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from hub.models.agent_protocol import (
    CmdExecFrame,
    CmdKillFrame,
    DoneFrame,
)

logger = logging.getLogger("hub.services.agent_registry")


# How long we wait for a `done` frame before declaring a dispatched
# command dead. Matches the documented default in devcontainer_manager.
DEFAULT_COMMAND_TIMEOUT_S = 120.0


@dataclass
class _PendingCommand:
    """Book-keeping for one in-flight cmd_exec."""

    command_id: str
    done: asyncio.Future[DoneFrame] = field(default_factory=asyncio.Future)
    output: asyncio.Queue[tuple[str, str]] = field(
        default_factory=lambda: asyncio.Queue(maxsize=10_000)
    )
    # pid gets filled in by the `ack` frame; useful for display.
    pid: int | None = None


class AgentConnection:
    """One live socket to an agent running in a specific container."""

    def __init__(self, container_id: str, websocket: WebSocket) -> None:
        self.container_id = container_id
        self.ws = websocket
        self.connected_at = time.monotonic()
        self.last_heartbeat_at: float = self.connected_at
        self._pending: dict[str, _PendingCommand] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def mark_heartbeat(self) -> None:
        self.last_heartbeat_at = time.monotonic()

    async def send_exec(
        self,
        command_id: str,
        command: str,
        env: dict[str, str] | None = None,
        timeout_s: float | None = None,
    ) -> _PendingCommand:
        """Dispatch a cmd_exec and return book-keeping for the caller."""
        async with self._lock:
            if command_id in self._pending:
                raise RuntimeError(f"command_id already in flight: {command_id}")
            pending = _PendingCommand(command_id=command_id)
            self._pending[command_id] = pending
        frame = CmdExecFrame(command_id=command_id, command=command, env=env, timeout_s=timeout_s)
        try:
            await self.ws.send_json(frame.model_dump(mode="json"))
        except Exception:
            # Roll back the pending entry so a caller retry doesn't
            # collide with a phantom in-flight command.
            async with self._lock:
                self._pending.pop(command_id, None)
            raise
        return pending

    async def send_kill(self, command_id: str) -> None:
        frame = CmdKillFrame(command_id=command_id)
        await self.ws.send_json(frame.model_dump(mode="json"))

    def deliver_ack(self, command_id: str, pid: int | None) -> None:
        pending = self._pending.get(command_id)
        if pending is not None:
            pending.pid = pid

    def deliver_output(self, command_id: str, stream: str, text: str) -> None:
        pending = self._pending.get(command_id)
        if pending is None:
            # Output for an unknown command — the dispatching coroutine
            # may have timed out and cleaned up. Drop silently.
            return
        # put_nowait is safe on an asyncio.Queue from any coroutine on
        # the same loop. When the queue is full we drop — a runaway
        # command isn't allowed to starve the event loop.
        try:
            pending.output.put_nowait((stream, text))
        except asyncio.QueueFull:
            logger.warning(
                "agent_output_queue_full",
                extra={"container_id": self.container_id, "command_id": command_id},
            )

    def deliver_done(self, frame: DoneFrame) -> None:
        pending = self._pending.pop(frame.command_id, None)
        if pending is None:
            return
        if not pending.done.done():
            pending.done.set_result(frame)
        # Signal end-of-output to any active stream consumer.
        with contextlib.suppress(asyncio.QueueFull):
            pending.output.put_nowait(("__done__", ""))

    async def close(self, reason: str = "closed") -> None:
        """Mark the connection closed and fail any in-flight commands."""
        if self._closed:
            return
        self._closed = True
        async with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for p in pending:
            if not p.done.done():
                p.done.set_exception(RuntimeError(f"agent disconnected: {reason}"))
            with contextlib.suppress(asyncio.QueueFull):
                p.output.put_nowait(("__done__", ""))


class AgentRegistry:
    """Process-wide map of ``container_id → AgentConnection``.

    Stored on ``app.state.agent_registry`` in lifespan start-up.
    """

    def __init__(self) -> None:
        self._by_container: dict[str, AgentConnection] = {}
        self._lock = asyncio.Lock()

    async def register(self, container_id: str, websocket: WebSocket) -> AgentConnection:
        """Insert a new connection. Evicts any prior connection for the same container."""
        async with self._lock:
            prior = self._by_container.get(container_id)
            if prior is not None:
                logger.info(
                    "agent_connection_replaced",
                    extra={"container_id": container_id},
                )
                # Close outside the lock further down.
                await prior.close(reason="replaced-by-new-connect")
            conn = AgentConnection(container_id, websocket)
            self._by_container[container_id] = conn
            return conn

    async def deregister(self, container_id: str, expected: AgentConnection) -> None:
        """Remove a connection only if it matches ``expected``.

        Prevents a stale handler from evicting a fresh reconnect that
        slotted in between its receive-loop ending and its finally clause.
        """
        async with self._lock:
            current = self._by_container.get(container_id)
            if current is expected:
                self._by_container.pop(container_id, None)

    def get(self, container_id: str) -> AgentConnection | None:
        return self._by_container.get(container_id)

    def has_live_connection(self, container_id: str) -> bool:
        conn = self._by_container.get(container_id)
        return conn is not None and not conn.closed

    def snapshot(self) -> list[dict[str, Any]]:
        """Return a JSON-safe summary of all current connections (for introspection)."""
        now = time.monotonic()
        return [
            {
                "container_id": cid,
                "connected_for_s": round(now - c.connected_at, 1),
                "last_heartbeat_age_s": round(now - c.last_heartbeat_at, 1),
                "pending_commands": len(c._pending),
            }
            for cid, c in self._by_container.items()
        ]

    async def close_all(self) -> None:
        async with self._lock:
            conns = list(self._by_container.values())
            self._by_container.clear()
        for c in conns:
            await c.close(reason="hub-shutdown")


async def stream_output(
    pending: _PendingCommand,
) -> AsyncIterator[tuple[str, str]]:
    """Yield (stream, text) tuples until the ``__done__`` sentinel arrives."""
    while True:
        stream, text = await pending.output.get()
        if stream == "__done__":
            return
        yield stream, text
