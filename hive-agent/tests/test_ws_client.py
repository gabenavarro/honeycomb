"""Tests for hive_agent.ws_client — URL construction and frame handlers.

The full run loop requires a real WebSocket against the hub; those
tests live in hub/tests/test_agent_endpoint.py where the hub's own
TestClient provides the counterpart. Here we cover the pure-Python
bits that don't need a live connection.
"""

from __future__ import annotations

import pytest
from hive_agent.protocol import (
    AckFrame,
    CmdExecFrame,
    CmdKillFrame,
    DoneFrame,
    OutputFrame,
)
from hive_agent.ws_client import HiveAgentWS, _http_to_ws


def test_http_to_ws_translates_scheme() -> None:
    assert _http_to_ws("http://host:8420") == "ws://host:8420"
    assert _http_to_ws("https://hub.example/api") == "wss://hub.example/api"
    # Unknown schemes are left as-is.
    assert _http_to_ws("ws://host:8420") == "ws://host:8420"


def test_connect_url_includes_token_and_container() -> None:
    client = HiveAgentWS(
        hub_url="http://hub.local:8420",
        container_id="c1",
        auth_token="secret",
    )
    url = client.connect_url
    assert url.startswith("ws://hub.local:8420/api/agent/connect?")
    assert "token=secret" in url
    assert "container=c1" in url


def test_connect_url_url_encodes_values() -> None:
    client = HiveAgentWS(
        hub_url="http://hub.local:8420",
        container_id="my container",
        auth_token="tok=with&chars",
    )
    url = client.connect_url
    # Spaces and `=`/`&` must be percent-encoded so the hub sees the
    # right values in the query string.
    assert "container=my+container" in url or "container=my%20container" in url
    # `=` and `&` inside the token value must be encoded as %3D and %26.
    assert "%3D" in url and "%26" in url


class FakeWS:
    """Minimal stand-in that records frames instead of sending over the wire."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send(self, payload: str) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_handle_exec_dispatches_ack_and_done() -> None:
    import json

    client = HiveAgentWS(
        hub_url="http://hub.local",
        container_id="c1",
        auth_token="tok",
    )
    fake_ws = FakeWS()
    client._ws = fake_ws  # type: ignore[assignment]

    await client._handle_exec(CmdExecFrame(command_id="abc", command="echo hi"))
    # A real session also runs _await_completion as a task, but we can
    # assert on the immediate ack frame.
    assert fake_ws.sent, "expected at least an ack frame"
    first = json.loads(fake_ws.sent[0])
    assert first["type"] == "ack"
    assert first["command_id"] == "abc"

    # Wait for the background completion watcher to emit its DoneFrame.
    # The command itself is fast (`echo hi`) so the watcher finishes in
    # well under a second; a 2s cap is generous and catches regressions.
    import asyncio as _asyncio
    import time

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        types = [json.loads(p)["type"] for p in fake_ws.sent]
        if "done" in types:
            break
        await _asyncio.sleep(0.02)
    types = [json.loads(p)["type"] for p in fake_ws.sent]
    assert "output" in types
    assert "done" in types


@pytest.mark.asyncio
async def test_handle_kill_on_running_command_emits_done() -> None:
    import json

    client = HiveAgentWS(
        hub_url="http://hub.local",
        container_id="c1",
        auth_token="tok",
    )
    fake_ws = FakeWS()
    client._ws = fake_ws  # type: ignore[assignment]

    # Start a long-running command so kill has something to terminate.
    await client.runner.run("sleep 30", command_id="c3")

    await client._handle_kill(CmdKillFrame(command_id="c3"))

    types = [json.loads(p)["type"] for p in fake_ws.sent]
    assert "done" in types
    done = next(json.loads(p) for p in fake_ws.sent if json.loads(p)["type"] == "done")
    assert done["command_id"] == "c3"
    assert done["reason"] == "killed"


def test_frame_models_can_be_dumped_and_parsed() -> None:
    from hive_agent.protocol import parse_frame

    src = OutputFrame(command_id="x", stream="stdout", text="t")
    assert isinstance(parse_frame(src.model_dump(mode="json")), OutputFrame)

    src2 = AckFrame(command_id="x", pid=12)
    assert isinstance(parse_frame(src2.model_dump(mode="json")), AckFrame)

    src3 = DoneFrame(command_id="x", exit_code=0)
    assert isinstance(parse_frame(src3.model_dump(mode="json")), DoneFrame)
