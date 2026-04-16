"""Tests for the PtySession + PtyRegistry that don't require a live
Docker daemon. We exercise the ring buffer + attach/detach semantics
with a fake socket and fake exec handle.

Session creation itself (exec_create → exec_start → hijacked socket) is
validated by P4.4 manual E2E against a real container — mocking
docker-py's internals deeply enough to replicate the hijacked socket is
more work than value.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from hub.services.pty_session import (
    SCROLLBACK_BYTES,
    SESSION_GRACE_SECONDS,
    PtySession,
    PtyRegistry,
)


def _fake_session(key=(1, "shell"), cid="cabc") -> PtySession:
    """Construct a PtySession without running the real reader loop."""
    api = MagicMock()
    return PtySession(
        key=key,
        container_id=cid,
        exec_id="exec-xyz",
        sock=MagicMock(),  # never touched by these tests
        cols=80,
        rows=24,
        api=api,
    )


class TestRingBuffer:
    def test_buffer_caps_at_max_bytes(self) -> None:
        s = _fake_session()
        chunk = b"x" * 1024
        for _ in range((SCROLLBACK_BYTES // 1024) + 10):  # deliberately overflow
            s._append_buffer(chunk)
        assert s._buffer_size <= SCROLLBACK_BYTES
        # And the tail is preserved — the *newest* bytes win.
        snap = s.snapshot_scrollback()
        assert snap[-1024:] == chunk

    def test_snapshot_concatenates_in_order(self) -> None:
        s = _fake_session()
        s._append_buffer(b"hello ")
        s._append_buffer(b"world")
        assert s.snapshot_scrollback() == b"hello world"


class TestAttachDetach:
    @pytest.mark.asyncio
    async def test_attach_displaces_previous_client(self) -> None:
        # Single-writer discipline: only the most recent attach receives
        # callbacks. Previous callbacks are orphaned silently.
        s = _fake_session()
        calls_a: list[bytes] = []
        calls_b: list[bytes] = []

        async def a(data: bytes) -> None:
            calls_a.append(data)

        async def b(data: bytes) -> None:
            calls_b.append(data)

        s.attach(a)
        if s._attached is not None:
            await s._attached(b"first")
        s.attach(b)
        if s._attached is not None:
            await s._attached(b"second")

        assert calls_a == [b"first"]
        assert calls_b == [b"second"]

    @pytest.mark.asyncio
    async def test_detach_without_evict_flag_does_not_schedule(self) -> None:
        s = _fake_session()
        s.detach(schedule_evict=False)
        assert s._evict_handle is None
        assert s._detached_at is not None

    @pytest.mark.asyncio
    async def test_detach_schedules_eviction(self) -> None:
        s = _fake_session()
        s.attach(lambda _d: None)  # type: ignore[arg-type]
        s.detach(schedule_evict=True)
        assert s._evict_handle is not None
        # Matches the grace period constant.
        when = s._evict_handle.when()
        now = asyncio.get_event_loop().time()
        delta = when - now
        assert SESSION_GRACE_SECONDS - 5 < delta <= SESSION_GRACE_SECONDS + 1
        # Clean up the pending handle so the test loop closes cleanly.
        s._evict_handle.cancel()

    @pytest.mark.asyncio
    async def test_reattach_cancels_pending_eviction(self) -> None:
        s = _fake_session()
        s.attach(lambda _d: None)  # type: ignore[arg-type]
        s.detach(schedule_evict=True)
        assert s._evict_handle is not None
        s.attach(lambda _d: None)  # type: ignore[arg-type]
        assert s._evict_handle is None
        assert s._detached_at is None


class TestRegistry:
    @pytest.mark.asyncio
    async def test_drop_by_container_closes_all_sessions_for_that_cid(self) -> None:
        reg = PtyRegistry()
        s_a = _fake_session(key=(1, "shell"), cid="cid-a")
        s_b = _fake_session(key=(2, "shell"), cid="cid-a")
        s_other = _fake_session(key=(3, "shell"), cid="cid-b")
        reg._sessions[s_a.key] = s_a
        reg._sessions[s_b.key] = s_b
        reg._sessions[s_other.key] = s_other

        dropped = await reg.drop_by_container("cid-a")
        assert dropped == 2
        assert s_a.closed and s_b.closed
        assert not s_other.closed
        assert set(reg._sessions.keys()) == {(3, "shell")}
        await reg.close_all()

    @pytest.mark.asyncio
    async def test_close_all_is_idempotent(self) -> None:
        reg = PtyRegistry()
        s = _fake_session()
        reg._sessions[s.key] = s
        await reg.close_all()
        # Second call after everything is closed shouldn't blow up.
        await reg.close_all()
        assert reg._sessions == {}
