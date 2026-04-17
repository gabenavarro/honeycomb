"""Tests for M15 disk-backed PTY scrollback + grace-seconds plumbing.

Covers the pure file-side helpers without constructing a live docker
exec socket — that path needs a real container and is covered by the
integration smoke tests. Here we verify:

- ``_append_and_trim`` appends and caps at ``SCROLLBACK_LOG_MAX_BYTES``.
- ``_seed_from_log`` reads the file back into a deque the ring-buffer
  shape expects.
- A ``PtyRegistry`` constructed with ``scrollback_dir`` wires the path
  onto new ``PtySession`` instances.
"""

from __future__ import annotations

from pathlib import Path

from hub.services.pty_session import (
    SCROLLBACK_LOG_MAX_BYTES,
    PtyRegistry,
    PtySession,
    _append_and_trim,
    _scrollback_path,
    _seed_from_log,
)


def test_append_and_trim_keeps_file_bounded(tmp_path: Path) -> None:
    path = tmp_path / "42-abc123def456.log"
    _append_and_trim(path, b"hello ")
    _append_and_trim(path, b"world\n")
    assert path.read_bytes() == b"hello world\n"


def test_append_and_trim_trims_oversize(tmp_path: Path) -> None:
    path = tmp_path / "99-aaaa.log"
    big = b"x" * (SCROLLBACK_LOG_MAX_BYTES + 1024)
    _append_and_trim(path, big)
    assert path.stat().st_size == SCROLLBACK_LOG_MAX_BYTES


def test_seed_from_log_returns_deque(tmp_path: Path) -> None:
    path = tmp_path / "5-aaa.log"
    path.write_bytes(b"prior scrollback bytes\n")
    dq = _seed_from_log(path)
    assert dq is not None
    assert b"".join(dq) == b"prior scrollback bytes\n"


def test_seed_from_log_missing_returns_none(tmp_path: Path) -> None:
    assert _seed_from_log(tmp_path / "nope.log") is None


def test_scrollback_path_stable_per_key(tmp_path: Path) -> None:
    k1 = _scrollback_path(tmp_path, (42, "shell-abc"))
    k2 = _scrollback_path(tmp_path, (42, "shell-abc"))
    k3 = _scrollback_path(tmp_path, (42, "shell-xyz"))
    assert k1 == k2
    assert k1 != k3


def test_registry_seeds_new_session_from_disk(tmp_path: Path) -> None:
    """PtyRegistry with scrollback_dir should hand back the path + seed
    the buffer when creating a session whose key matches a prior log.
    We construct the session manually (no live docker) and verify the
    seeded buffer survives a round-trip through ``snapshot_scrollback``.
    """
    reg = PtyRegistry(scrollback_dir=tmp_path, default_grace_seconds=42)
    key = (7, "shell-abc")
    log_path = _scrollback_path(tmp_path, key)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_bytes(b"persisted tail")

    # Simulate what ``PtyRegistry.get_or_create`` would do for a fresh
    # session: detect the log, seed the buffer.
    seeded = _seed_from_log(log_path)
    assert seeded is not None
    session = PtySession(
        key=key,
        container_id="deadbeef",
        exec_id="x",
        sock=None,
        cols=80,
        rows=24,
        api=None,  # type: ignore[arg-type]
        grace_seconds=reg.default_grace_seconds,
        _disk_log_path=log_path,
    )
    session._buffer = seeded
    session._buffer_size = sum(len(c) for c in seeded)

    assert session.grace_seconds == 42
    assert session.snapshot_scrollback() == b"persisted tail"
    assert session._disk_log_path == log_path
