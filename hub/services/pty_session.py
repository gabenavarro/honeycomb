"""Persistent PTY sessions over Docker exec sockets.

Architecture (per session):

    xterm.js  <─── WebSocket ───>  hub  <─── raw docker socket ───>  PTY in container
                                   |
                                   ring buffer (64 KB) for reattach

Why not `docker exec -i` via subprocess? That path goes through the
docker CLI which doesn't stream cleanly into asyncio. The Docker Engine
HTTP API exposes a hijacked TCP socket via the low-level APIClient;
docker-py returns it as a `SocketIO`-ish stream that we can register
with the event loop directly via `add_reader`.

Session identity is `(record_id, session_label)`. The same label from a
reconnecting browser tab re-attaches to the same PTY, restoring a 64 KB
scrollback tail so the user sees what happened while they were gone.
On detach (WebSocket close without `kill`) we hold the PTY open for
SESSION_GRACE_SECONDS — long enough to outlast browser tab suspension.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import docker
import docker.errors

logger = logging.getLogger("hub.pty_session")

# Keep a detached session open this long before killing the PTY. Chrome
# / Firefox suspend background tabs after ~5 min; matching that lets a
# user come back to a running `npm install` without losing it.
SESSION_GRACE_SECONDS = 300

# Ring buffer for each session. 64 KB fits a ~1000-line scrollback tail
# at 64 chars/line — enough for an "I was gone, what did I miss?" replay
# without inflating hub memory for idle long-lived sessions.
SCROLLBACK_BYTES = 64 * 1024

# Max chunk we read from the docker socket per loop iteration. Larger
# chunks reduce syscalls at the cost of perceived latency on noisy
# output; 4 KB matches typical line-buffered stdout.
READ_CHUNK_BYTES = 4096


OutputCallback = Callable[[bytes], Awaitable[None] | None]


def _unwrap_sock(hijacked: Any) -> Any:
    """Return the raw socket.socket inside docker-py's SocketIO wrapper.

    docker-py 7.x returns a `socket.SocketIO` from `exec_start(socket=True)`.
    SocketIO is a `RawIOBase` — it only exposes `read`/`write`, not
    `recv`/`send`. For a bidirectional PTY stream we need the underlying
    `socket.socket` via `._sock`, which supports both and has predictable
    non-blocking semantics. Returns the input unchanged if it's already
    a raw socket.
    """
    inner = getattr(hijacked, "_sock", None)
    if inner is not None and hasattr(inner, "recv") and hasattr(inner, "send"):
        return inner
    return hijacked


@dataclass
class PtySession:
    """One PTY running inside a container, plus the plumbing to attach
    zero or more WebSocket clients to it.

    Why "zero or more": detach keeps the PTY alive without any attached
    reader; the output pump still runs, writing into the ring buffer,
    so a reattacher sees the tail on arrival.

    Why not one reader per client: a PTY is a byte stream — splitting
    the same bytes across multiple attached clients is fine, but two
    writers (stdin) would interleave keystrokes into garbage. We enforce
    single-writer: a new attach displaces the previous client.
    """

    key: tuple[int, str]
    container_id: str
    exec_id: str
    # The raw TCP socket (socket.socket) extracted from docker-py's
    # SocketIO wrapper. Supports .recv()/.send() with real blocking
    # semantics. Used for all I/O.
    sock: Any
    cols: int
    rows: int
    api: docker.APIClient
    # The SocketIO wrapper from docker-py; we hold on to it so
    # .close() goes through docker-py's cleanup path (file-descriptor
    # bookkeeping inside urllib3). Not used for I/O.
    _wrapper: Any = None

    # ring buffer of recent output bytes for reattach replay
    _buffer: deque[bytes] = field(default_factory=deque)
    _buffer_size: int = 0
    # set when the reader task exits (PTY died).
    _closed: asyncio.Event = field(default_factory=asyncio.Event)
    # the attached client's callback, if any.
    _attached: OutputCallback | None = None
    # scheduled eviction timer id (from loop.call_later) during grace.
    _evict_handle: asyncio.TimerHandle | None = None
    # wall-clock of last detach, used for the "+N since" banner.
    _detached_at: float | None = None
    # reader task handle; cancelled on close.
    _reader_task: asyncio.Task[None] | None = None

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def _append_buffer(self, chunk: bytes) -> None:
        self._buffer.append(chunk)
        self._buffer_size += len(chunk)
        while self._buffer_size > SCROLLBACK_BYTES and self._buffer:
            dropped = self._buffer.popleft()
            self._buffer_size -= len(dropped)

    def snapshot_scrollback(self) -> bytes:
        return b"".join(self._buffer)

    async def write(self, data: bytes) -> None:
        """Forward client keystrokes to the PTY's stdin."""
        if self._closed.is_set():
            return
        # The hijacked socket is blocking; wrap the send in a thread so
        # we don't stall the event loop under slow-network conditions.
        await asyncio.to_thread(_send_all, self.sock, data)

    async def resize(self, cols: int, rows: int) -> None:
        """Tell the PTY to reflow to new terminal dimensions."""
        if self._closed.is_set():
            return
        if cols <= 0 or rows <= 0:
            return
        self.cols, self.rows = cols, rows
        try:
            await asyncio.to_thread(self.api.exec_resize, self.exec_id, height=rows, width=cols)
        except docker.errors.APIError as exc:
            logger.debug("exec_resize failed for %s: %s", self.exec_id, exc)

    def attach(self, callback: OutputCallback) -> None:
        """Route future output bytes to `callback`. Any previously
        attached client is displaced (its writer loses the session — see
        single-writer rationale above)."""
        self._attached = callback
        # Cancel pending eviction if we were in grace.
        if self._evict_handle is not None:
            self._evict_handle.cancel()
            self._evict_handle = None
            self._detached_at = None

    def detach(self, *, schedule_evict: bool = True) -> None:
        """Drop the current client. Optionally arms the grace timer;
        pass False for `kill()` semantics (caller wants immediate close)."""
        self._attached = None
        self._detached_at = time.time()
        if schedule_evict and not self._closed.is_set():
            loop = asyncio.get_event_loop()
            self._evict_handle = loop.call_later(
                SESSION_GRACE_SECONDS, lambda: asyncio.create_task(self.close())
            )

    async def close(self) -> None:
        """Tear down the PTY and free resources. Idempotent."""
        if self._closed.is_set():
            return
        self._closed.set()
        if self._evict_handle is not None:
            self._evict_handle.cancel()
            self._evict_handle = None
        if self._reader_task is not None:
            self._reader_task.cancel()
        # Close the SocketIO wrapper first (runs urllib3 cleanup), then
        # the raw socket — this order avoids a "closed twice" warning
        # on some docker-py versions.
        for s in (self._wrapper, self.sock):
            if s is None:
                continue
            with contextlib.suppress(Exception):
                s.close()
        self._attached = None
        logger.info("PTY session %s closed", self.key)

    def seconds_since_detach(self) -> float | None:
        return None if self._detached_at is None else (time.time() - self._detached_at)


def _send_all(sock: Any, data: bytes) -> None:
    """Blocking send that handles short writes — the docker hijacked
    socket sometimes accepts fewer bytes than asked when the PTY is
    backpressured."""
    view = memoryview(data)
    total = 0
    while total < len(data):
        n = sock.send(view[total:])
        if n == 0:
            raise OSError("docker socket closed during send")
        total += n


def _recv_chunk(sock: Any, n: int) -> bytes:
    """Blocking read used inside asyncio.to_thread. `recv` is preferred
    over `read` because the hijacked object from docker-py is a
    SocketIO-ish wrapper where `recv` is always present."""
    try:
        return sock.recv(n)
    except OSError:
        return b""


class PtyRegistry:
    """Process-wide map of live PTY sessions, keyed by (record_id, label)."""

    def __init__(self) -> None:
        self._sessions: dict[tuple[int, str], PtySession] = {}
        self._lock = asyncio.Lock()

    def _update_gauge(self) -> None:
        """Snapshot len(sessions) into the Prometheus gauge.

        Imported lazily so the pty_session module stays importable in
        tests that don't want the metrics side effect on the process-
        global registry.
        """
        from hub.services import metrics

        metrics.pty_sessions.set(len(self._sessions))

    async def get_or_create(
        self,
        *,
        record_id: int,
        session_label: str,
        container_id: str,
        command: list[str],
        cols: int,
        rows: int,
        env: dict[str, str] | None = None,
    ) -> tuple[PtySession, bool]:
        """Return (session, reattached). On reattach the caller should
        replay `snapshot_scrollback()` before attaching the WS reader."""
        async with self._lock:
            key = (record_id, session_label)
            existing = self._sessions.get(key)
            if existing is not None and not existing.closed:
                # Resize in case the new client has a different viewport.
                if (cols, rows) != (existing.cols, existing.rows):
                    await existing.resize(cols, rows)
                return existing, True

            # Fresh session — create the exec, hijack the socket, and
            # start the reader pump.
            api = docker.APIClient()
            exec_id = api.exec_create(
                container_id,
                cmd=command,
                tty=True,
                stdin=True,
                stdout=True,
                stderr=True,
                environment=env or {},
            )["Id"]
            hijacked = api.exec_start(exec_id, socket=True, tty=True, stream=True, demux=False)
            raw_sock = _unwrap_sock(hijacked)
            # Apply initial dimensions.
            with contextlib.suppress(docker.errors.APIError):
                api.exec_resize(exec_id, height=rows, width=cols)

            session = PtySession(
                key=key,
                container_id=container_id,
                exec_id=exec_id,
                sock=raw_sock,
                cols=cols,
                rows=rows,
                api=api,
                _wrapper=hijacked,
            )
            session._reader_task = asyncio.create_task(_reader_loop(session))
            self._sessions[key] = session
            self._update_gauge()
            logger.info(
                "PTY session %s started (exec=%s cmd=%s)",
                key,
                exec_id[:12],
                " ".join(command),
            )
            return session, False

    async def get(self, record_id: int, session_label: str) -> PtySession | None:
        return self._sessions.get((record_id, session_label))

    async def drop(self, session: PtySession) -> None:
        """Remove a session from the registry and close it."""
        async with self._lock:
            self._sessions.pop(session.key, None)
            self._update_gauge()
        await session.close()

    async def drop_by_container(self, container_id: str) -> int:
        """Evict every session bound to a container (used when the
        container stops / is removed). Returns how many were dropped."""
        victims: list[PtySession] = []
        async with self._lock:
            for key, s in list(self._sessions.items()):
                if s.container_id == container_id:
                    victims.append(s)
                    del self._sessions[key]
            self._update_gauge()
        for s in victims:
            await s.close()
        return len(victims)

    async def close_all(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            self._update_gauge()
        for s in sessions:
            await s.close()

    def all(self) -> list[PtySession]:
        return list(self._sessions.values())


async def _reader_loop(session: PtySession) -> None:
    """Pump bytes from the docker socket into the ring buffer + the
    currently-attached client's callback. Runs until the socket closes
    or the session is explicitly closed.

    We use `asyncio.to_thread` for the blocking recv. One thread per
    session, which is fine at the target fleet size (7+). Avoids the
    `loop.sock_recv` dance which requires a bare socket fd; docker-py
    hands us a SocketIO wrapper whose fd extraction varies across
    versions and breaks on close."""
    sock = session.sock
    try:
        while not session.closed:
            data = await asyncio.to_thread(_recv_chunk, sock, READ_CHUNK_BYTES)
            if not data:
                break  # EOF — the exec'd process exited
            session._append_buffer(data)
            cb = session._attached
            if cb is not None:
                try:
                    res = cb(data)
                    if asyncio.iscoroutine(res):
                        await res
                except Exception as exc:
                    logger.info(
                        "Attached client callback raised for %s: %s — detaching",
                        session.key,
                        exc,
                    )
                    session.detach(schedule_evict=True)
    finally:
        if not session.closed:
            await session.close()
