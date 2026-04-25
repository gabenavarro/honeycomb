"""WebSocket client that dials the Claude Hive hub from inside a container.

Replaces the pre-M4 HTTP listener + heartbeat loop with a single
persistent WebSocket to ``/api/agent/connect``. The same socket carries:

* outgoing frames: ``hello``, ``heartbeat``, ``ack``, ``output``, ``done``;
* incoming frames: ``cmd_exec``, ``cmd_kill``.

Why reverse-tunnel? The HTTP listener required the container to expose a
port the hub could reach. That's a surface an attacker on the Docker
bridge could touch, and a pain across network topologies (dev-over-SSH,
compose-based fleets, etc.). A client-initiated WebSocket moves the
connection direction to the easy side of the firewall and — since
M3 — is authenticated with the hub's bearer token.

Reconnect strategy
------------------
On any loss of the socket we back off exponentially (1s → 30s cap) and
retry forever. A container that boots before the hub is ready, or a
hub that restarts, recover naturally without operator intervention. In
the meantime, hub-side callers see ``has_live_agent=False`` and fall
back to ``devcontainer exec`` / ``docker exec``.

Environment
-----------
* ``HIVE_HUB_URL`` — base URL (``http`` or ``https``). Translated to
  ``ws``/``wss`` for the handshake.
* ``HIVE_AUTH_TOKEN`` — required. Missing tokens log a warning but the
  client still tries to connect (the hub will close 1008 and we'll
  retry).
* ``HIVE_CONTAINER_ID`` — overrides the default (system hostname).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import socket
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import websockets
from pydantic import ValidationError
from websockets.exceptions import ConnectionClosed, InvalidStatus

from hive_agent.command_runner import CommandRunner
from hive_agent.protocol import (
    AckFrame,
    CmdExecFrame,
    CmdKillFrame,
    DiffEventFrame,
    DoneFrame,
    HeartbeatFrame,
    HelloFrame,
    OutputFrame,
    parse_frame,
)
from hive_agent.socket_listener import SocketListener

logger = logging.getLogger("hive_agent.ws_client")


AGENT_VERSION = "0.4.0"

DEFAULT_HEARTBEAT_S = 5.0
DEFAULT_RECONNECT_BASE_S = 1.0
DEFAULT_RECONNECT_MAX_S = 30.0
DEFAULT_SOCKET_PATH = "/run/honeycomb/agent.sock"


def _http_to_ws(url: str) -> str:
    """Translate ``http://…`` → ``ws://…`` (and ``https://`` → ``wss://``)."""
    parts = urlsplit(url)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, parts.fragment))


class HiveAgentWS:
    """Long-running WebSocket client that represents one hive-agent to the hub."""

    def __init__(
        self,
        hub_url: str | None = None,
        container_id: str | None = None,
        auth_token: str | None = None,
        heartbeat_interval: float = DEFAULT_HEARTBEAT_S,
        reconnect_base_s: float = DEFAULT_RECONNECT_BASE_S,
        reconnect_max_s: float = DEFAULT_RECONNECT_MAX_S,
        socket_path: str | None = None,
    ) -> None:
        self.hub_url = (
            hub_url or os.environ.get("HIVE_HUB_URL", "http://host.docker.internal:8420")
        ).rstrip("/")
        self.container_id = container_id or os.environ.get(
            "HIVE_CONTAINER_ID", socket.gethostname()
        )
        self.auth_token = auth_token or os.environ.get("HIVE_AUTH_TOKEN") or ""
        self.heartbeat_interval = heartbeat_interval
        self.reconnect_base_s = reconnect_base_s
        self.reconnect_max_s = reconnect_max_s
        self._started_at = datetime.now(UTC).isoformat()

        # Current status reported on every heartbeat. Uses the string
        # values from the protocol's HeartbeatFrame.status literal.
        self.status: str = "starting"

        self.runner = CommandRunner(line_callback=self._on_command_line)

        # websockets changed its public API surface across versions; use
        # Any so this stays compatible without pinning to a private path.
        self._ws: Any = None
        self._writer_lock = asyncio.Lock()
        self._shutdown = asyncio.Event()
        self._run_task: asyncio.Task[None] | None = None
        # Strong references to per-command completion-watcher tasks; see
        # the analogous comment in CommandRunner for why this matters.
        self._pending_tasks: set[asyncio.Task[None]] = set()

        # Unix-socket listener for diff events (M27).
        self._socket_path: str = socket_path or os.environ.get(
            "HIVE_AGENT_SOCKET", DEFAULT_SOCKET_PATH
        )
        self._socket_listener: SocketListener | None = None
        self._socket_listener_task: asyncio.Task[None] | None = None

    # ── Public API ───────────────────────────────────────────────────

    @property
    def connect_url(self) -> str:
        """Full ws:// URL including token + container query params."""
        base = _http_to_ws(self.hub_url)
        params = urlencode(
            {"token": self.auth_token, "container": self.container_id},
        )
        return f"{base}/api/agent/connect?{params}"

    async def start(self) -> None:
        """Start the reconnecting run loop in the background."""
        if self._run_task is not None and not self._run_task.done():
            return
        if not self.auth_token:
            logger.warning(
                "hive_agent_missing_token",
                extra={"hub_url": self.hub_url, "container_id": self.container_id},
            )
        self.status = "idle"
        self._run_task = asyncio.create_task(self._run(), name="hive-agent-ws-run")

        self._socket_listener = SocketListener(
            socket_path=Path(self._socket_path),
            submit_diff=self.submit_diff,
        )
        self._socket_listener_task = asyncio.create_task(
            self._socket_listener.serve(), name="hive-agent-socket-listener"
        )

    async def stop(self) -> None:
        """Request shutdown, close the socket, and wait for the run loop to exit."""
        self._shutdown.set()
        self.status = "stopping"
        ws = self._ws
        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()
        if self._run_task is not None:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._run_task
            self._run_task = None
        if self._socket_listener is not None:
            self._socket_listener.stop()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._socket_listener_task, timeout=2.0)
            self._socket_listener = None
            self._socket_listener_task = None

    async def submit_diff(
        self,
        *,
        tool: str,
        path: str,
        diff: str,
        tool_use_id: str,
        claude_session_id: str | None = None,
        added_lines: int = 0,
        removed_lines: int = 0,
        timestamp: str,
    ) -> None:
        """Send a DiffEventFrame to the hub (M27).

        Best-effort. If the WS isn't connected we log + drop —
        diff capture must never block the calling hook script."""
        if self._ws is None:
            logger.warning("submit_diff: no active websocket; dropping event")
            return
        frame = DiffEventFrame(
            container_id=self.container_id,
            tool=tool,  # type: ignore[arg-type]
            path=path,
            diff=diff,
            tool_use_id=tool_use_id,
            claude_session_id=claude_session_id,
            added_lines=added_lines,
            removed_lines=removed_lines,
            timestamp=timestamp,
        )
        try:
            await self._send_frame(frame)
        except Exception as exc:
            logger.warning("submit_diff: send failed: %s", exc)

    # ── Run loop ─────────────────────────────────────────────────────

    async def _run(self) -> None:
        """Outer reconnect loop. Exits only when ``_shutdown`` is set."""
        delay = self.reconnect_base_s
        while not self._shutdown.is_set():
            try:
                await self._session()
                # Clean exit (hub closed) — reset backoff and retry.
                delay = self.reconnect_base_s
            except (OSError, ConnectionClosed, InvalidStatus) as exc:
                logger.info(
                    "hive_agent_ws_disconnect",
                    extra={"reason": type(exc).__name__, "delay_s": delay},
                )
            except Exception:
                logger.exception("hive_agent_ws_unhandled_error")
            if self._shutdown.is_set():
                return
            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=delay)
                return
            except TimeoutError:
                pass
            delay = min(delay * 2, self.reconnect_max_s)

    async def _session(self) -> None:
        """One connection lifecycle: connect → hello → heartbeat + receive → disconnect."""
        async with websockets.connect(
            self.connect_url,
            open_timeout=10.0,
            ping_interval=None,  # we send our own heartbeat frames
            max_size=16 * 1024 * 1024,
        ) as ws:
            self._ws = ws
            logger.info(
                "hive_agent_ws_connected",
                extra={"container_id": self.container_id, "hub": self.hub_url},
            )
            try:
                await self._send_frame(
                    HelloFrame(
                        container_id=self.container_id,
                        agent_version=AGENT_VERSION,
                        started_at=self._started_at,
                        hostname=socket.gethostname(),
                    )
                )
                heartbeat_task = asyncio.create_task(
                    self._heartbeat_loop(), name="hive-agent-heartbeat"
                )
                try:
                    await self._receive_loop()
                finally:
                    heartbeat_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await heartbeat_task
            finally:
                self._ws = None

    # ── Senders ──────────────────────────────────────────────────────

    async def _send_frame(self, frame: Any) -> None:
        """Serialise + send ``frame`` while holding the writer lock.

        websockets' protocol serialises sends in practice but the lock
        guarantees we never interleave a heartbeat and an output frame's
        bytes on the wire — important when output throughput is high.
        """
        ws = self._ws
        if ws is None:
            return
        payload = frame.model_dump(mode="json")
        async with self._writer_lock:
            await ws.send(_json_dumps(payload))

    async def _heartbeat_loop(self) -> None:
        try:
            while True:
                await self._send_frame(
                    HeartbeatFrame(
                        container_id=self.container_id,
                        status=self.status,  # type: ignore[arg-type]
                    )
                )
                await asyncio.sleep(self.heartbeat_interval)
        except asyncio.CancelledError:
            return
        except Exception:
            # Let the session-level loop decide what to do — logging the
            # underlying error is enough here.
            logger.debug("hive_agent_heartbeat_failed", exc_info=True)

    # ── Receivers ────────────────────────────────────────────────────

    async def _receive_loop(self) -> None:
        ws = self._ws
        if ws is None:
            return
        async for raw in ws:
            try:
                payload = _json_loads(raw)
                frame = parse_frame(payload)
            except (ValueError, ValidationError) as exc:
                logger.warning(
                    "hive_agent_frame_invalid",
                    extra={"error": str(exc)[:400]},
                )
                continue

            if isinstance(frame, CmdExecFrame):
                await self._handle_exec(frame)
            elif isinstance(frame, CmdKillFrame):
                await self._handle_kill(frame)
            # Any other frame type is either agent→hub (we shouldn't
            # receive it) or a future extension. Log and drop.
            else:
                logger.debug(
                    "hive_agent_frame_unexpected",
                    extra={"type": getattr(frame, "type", "?")},
                )

    async def _handle_exec(self, frame: CmdExecFrame) -> None:
        try:
            info = await self.runner.run(frame.command, command_id=frame.command_id, env=frame.env)
        except Exception as exc:
            logger.warning(
                "hive_agent_exec_failed",
                extra={"command_id": frame.command_id, "error": str(exc)},
            )
            await self._send_frame(
                DoneFrame(
                    command_id=frame.command_id,
                    exit_code=-1,
                    reason=f"spawn-failed: {exc}",
                )
            )
            return
        await self._send_frame(AckFrame(command_id=frame.command_id, pid=info.get("pid")))
        # Fire-and-forget completion watcher — emits the final done frame
        # once the process actually exits. The output callback has
        # already streamed bytes back in real time.
        self.status = "busy"
        task = asyncio.create_task(self._await_completion(frame.command_id))
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)

    async def _handle_kill(self, frame: CmdKillFrame) -> None:
        killed = await self.runner.kill(frame.command_id)
        if killed:
            await self._send_frame(
                DoneFrame(
                    command_id=frame.command_id,
                    exit_code=-15,
                    reason="killed",
                )
            )

    async def _await_completion(self, command_id: str) -> None:
        try:
            rc = await self.runner.wait(command_id)
        except Exception as exc:
            logger.warning(
                "hive_agent_wait_failed",
                extra={"command_id": command_id, "error": str(exc)},
            )
            rc = -1
        try:
            await self._send_frame(
                DoneFrame(
                    command_id=command_id,
                    exit_code=rc,
                    pid=self.runner.pid(command_id),
                    reason="completed" if rc == 0 else "exited",
                )
            )
        finally:
            # Return to idle only if there are no other commands in flight.
            if not any(self.runner.is_running(cid) for cid in list(self.runner._processes)):
                self.status = "idle"

    # ── Output pump (wired to CommandRunner) ────────────────────────

    async def _on_command_line(self, command_id: str, stream: str, text: str) -> None:
        """Convert a CommandRunner line into an OutputFrame and send it.

        The CommandRunner emits ``exit`` events too — we drop those since
        the WebSocket flow uses a dedicated DoneFrame.
        """
        if stream not in ("stdout", "stderr"):
            return
        try:
            await self._send_frame(
                OutputFrame(command_id=command_id, stream=stream, text=text)  # type: ignore[arg-type]
            )
        except Exception as exc:
            logger.debug(
                "hive_agent_output_send_failed",
                extra={"command_id": command_id, "error": str(exc)},
            )


def _json_dumps(payload: dict[str, Any]) -> str:
    import json

    return json.dumps(payload, separators=(",", ":"))


def _json_loads(raw: str | bytes) -> Any:
    import json

    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    return json.loads(raw)
