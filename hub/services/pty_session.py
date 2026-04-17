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
import hashlib
import logging
import os
import time
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import docker
import docker.errors

logger = logging.getLogger("hub.pty_session")

# Default grace window when the hub didn't supply one. Since M15 callers
# normally pass ``HiveSettings.pty_grace_seconds`` through ``PtyRegistry``
# so the value tracks configuration. 300 s is the pre-M15 default kept
# here for tests that construct ``PtySession`` directly.
SESSION_GRACE_SECONDS = 300

# Ring buffer for each session. 64 KB fits a ~1000-line scrollback tail
# at 64 chars/line — enough for an "I was gone, what did I miss?" replay
# without inflating hub memory for idle long-lived sessions.
SCROLLBACK_BYTES = 64 * 1024

# Disk log cap per session — matches the in-memory ring buffer. Writing
# more than this to disk buys nothing because replay still trims to the
# buffer cap.
SCROLLBACK_LOG_MAX_BYTES = SCROLLBACK_BYTES


def _scrollback_path(dir_path: Path, key: tuple[int, str]) -> Path:
    """Stable, filesystem-safe filename per (record_id, label) key.

    Hashing the label avoids collisions with punctuation/UUID characters
    while keeping the record_id in the name for operator legibility.
    """
    record_id, label = key
    digest = hashlib.sha1(label.encode("utf-8")).hexdigest()[:12]
    return dir_path / f"{record_id}-{digest}.log"


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
    # Per-session grace window. Defaults to the module-level constant so
    # pre-M15 constructors keep working; the registry passes the
    # ``HiveSettings.pty_grace_seconds`` value when creating sessions.
    grace_seconds: int = SESSION_GRACE_SECONDS
    # Dual-write target for the scrollback. None = disk-backing disabled.
    _disk_log_path: Path | None = None

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def _append_buffer(self, chunk: bytes) -> None:
        self._buffer.append(chunk)
        self._buffer_size += len(chunk)
        while self._buffer_size > SCROLLBACK_BYTES and self._buffer:
            dropped = self._buffer.popleft()
            self._buffer_size -= len(dropped)
        # Dual-write to disk so a hub restart can seed the next session
        # with the same scrollback. Appending, then re-trimming to the
        # in-memory cap keeps the log bounded without tracking offsets.
        # Errors here must never propagate — a failed write loses cache,
        # nothing user-visible breaks.
        if self._disk_log_path is not None:
            try:
                _append_and_trim(self._disk_log_path, chunk)
            except OSError as exc:
                logger.debug("Scrollback disk-write failed for %s: %s", self.key, exc)
                # Disable further attempts so we don't log the same error
                # every few KB.
                self._disk_log_path = None

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
        if schedule_evict and not self._closed.is_set() and self.grace_seconds > 0:
            loop = asyncio.get_event_loop()
            self._evict_handle = loop.call_later(
                self.grace_seconds, lambda: asyncio.create_task(self.close())
            )
        elif schedule_evict and self.grace_seconds == 0 and not self._closed.is_set():
            # Grace disabled: close immediately on detach (legacy path).
            asyncio.get_event_loop().create_task(self.close())

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


def _append_and_trim(path: Path, chunk: bytes) -> None:
    """Append ``chunk`` to ``path``, then trim the file to the last
    ``SCROLLBACK_LOG_MAX_BYTES``. Cheap for the expected workload —
    terminal output arrives in small bursts, and a ``pathlib`` read +
    slice on a 64 KB file is microseconds.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as f:
        f.write(chunk)
    size = path.stat().st_size
    if size > SCROLLBACK_LOG_MAX_BYTES:
        # Read the tail into memory (bounded by the cap) and rewrite.
        # Using the cheap re-truncate approach keeps the implementation
        # single-threaded and avoids partial-write windows: the OS
        # guarantees ``os.replace`` atomicity so another reader never
        # sees a corrupted log.
        with path.open("rb") as f:
            f.seek(-SCROLLBACK_LOG_MAX_BYTES, os.SEEK_END)
            tail = f.read()
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(tail)
        os.replace(tmp, path)


def _seed_from_log(path: Path) -> deque[bytes] | None:
    """Read a persisted scrollback log back into a deque the way the
    ring buffer expects. Returns None when the file is missing or the
    read fails — either condition just means "fresh session"."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if not data:
        return None
    dq: deque[bytes] = deque()
    dq.append(data)
    return dq


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
    """Process-wide map of live PTY sessions, keyed by (record_id, label).

    M15 adds two knobs — a default grace window applied to every new
    session, and an optional disk-log directory so scrollback dual-writes
    survive hub restarts. Both default to the pre-M15 behaviour so tests
    that construct a bare ``PtyRegistry()`` keep working.
    """

    def __init__(
        self,
        *,
        default_grace_seconds: int = SESSION_GRACE_SECONDS,
        scrollback_dir: Path | None = None,
    ) -> None:
        self._sessions: dict[tuple[int, str], PtySession] = {}
        self._lock = asyncio.Lock()
        self.default_grace_seconds = default_grace_seconds
        self.scrollback_dir = scrollback_dir

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

            disk_log: Path | None = None
            seeded_buffer: deque[bytes] | None = None
            seeded_size = 0
            if self.scrollback_dir is not None:
                disk_log = _scrollback_path(self.scrollback_dir, key)
                # Seed the in-memory ring buffer with whatever we have on
                # disk so the very first ``sreplay`` frame after hub
                # restart still shows the tail the user had before.
                seeded_buffer = _seed_from_log(disk_log)
                if seeded_buffer is not None:
                    seeded_size = sum(len(chunk) for chunk in seeded_buffer)

            session = PtySession(
                key=key,
                container_id=container_id,
                exec_id=exec_id,
                sock=raw_sock,
                cols=cols,
                rows=rows,
                api=api,
                _wrapper=hijacked,
                grace_seconds=self.default_grace_seconds,
                _disk_log_path=disk_log,
            )
            if seeded_buffer is not None:
                session._buffer = seeded_buffer
                session._buffer_size = seeded_size
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
