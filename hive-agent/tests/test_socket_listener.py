"""Tests for the M27 Unix-socket listener."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from hive_agent.socket_listener import SocketListener


@pytest.mark.asyncio
async def test_listener_calls_submit_diff_on_jsonl(tmp_path: Path) -> None:
    sock_path = tmp_path / "agent.sock"
    submit_diff = AsyncMock()
    listener = SocketListener(socket_path=sock_path, submit_diff=submit_diff)

    server_task = asyncio.create_task(listener.serve())
    for _ in range(50):
        if sock_path.exists():
            break
        await asyncio.sleep(0.01)
    assert sock_path.exists()

    _reader, writer = await asyncio.open_unix_connection(str(sock_path))
    payload = {
        "tool": "Edit",
        "path": "/workspace/foo.py",
        "diff": "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        "tool_use_id": "toolu_1",
        "claude_session_id": "sess",
        "added_lines": 1,
        "removed_lines": 1,
        "timestamp": "2026-04-23T07:38:00Z",
    }
    writer.write((json.dumps(payload) + "\n").encode("utf-8"))
    await writer.drain()
    writer.close()
    await writer.wait_closed()

    for _ in range(50):
        if submit_diff.await_count >= 1:
            break
        await asyncio.sleep(0.02)

    listener.stop()
    await asyncio.wait_for(server_task, timeout=2.0)

    assert submit_diff.await_count == 1
    kwargs = submit_diff.await_args.kwargs
    assert kwargs["tool"] == "Edit"
    assert kwargs["path"] == "/workspace/foo.py"


@pytest.mark.asyncio
async def test_listener_socket_file_perms(tmp_path: Path) -> None:
    """The socket file must be created mode 0660 so that only the
    Claude-running user can write to it."""
    sock_path = tmp_path / "agent.sock"
    submit_diff = AsyncMock()
    listener = SocketListener(socket_path=sock_path, submit_diff=submit_diff)
    server_task = asyncio.create_task(listener.serve())
    for _ in range(50):
        if sock_path.exists():
            break
        await asyncio.sleep(0.01)
    mode = os.stat(sock_path).st_mode & 0o777
    assert mode == 0o660
    listener.stop()
    await asyncio.wait_for(server_task, timeout=2.0)
