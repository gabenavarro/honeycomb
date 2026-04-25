"""Tests for HiveAgentWS.submit_diff (M27)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from hive_agent.ws_client import HiveAgentWS


@pytest.mark.asyncio
async def test_submit_diff_sends_frame_on_live_ws() -> None:
    """submit_diff builds a DiffEventFrame and writes its JSON form
    to the active WebSocket connection."""
    client = HiveAgentWS(hub_url="http://h", container_id="c-7")
    fake_ws = AsyncMock()
    client._ws = fake_ws

    await client.submit_diff(
        tool="Edit",
        path="/workspace/foo.py",
        diff="--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
        tool_use_id="toolu_1",
        claude_session_id="sess",
        added_lines=1,
        removed_lines=1,
        timestamp="2026-04-23T07:38:00Z",
    )

    fake_ws.send.assert_awaited_once()
    payload = json.loads(fake_ws.send.await_args.args[0])
    assert payload["type"] == "diff_event"
    assert payload["container_id"] == "c-7"
    assert payload["tool"] == "Edit"
    assert payload["path"] == "/workspace/foo.py"
    assert payload["added_lines"] == 1


@pytest.mark.asyncio
async def test_submit_diff_no_active_ws_silently_drops() -> None:
    """If the WS isn't connected, submit_diff must not raise — the
    hook script that called us is not in a position to recover."""
    client = HiveAgentWS(hub_url="http://h", container_id="c-7")
    client._ws = None
    # Should not raise.
    await client.submit_diff(
        tool="Edit",
        path="/workspace/foo.py",
        diff="…",
        tool_use_id="toolu_1",
        timestamp="2026-04-23T07:38:00Z",
    )
