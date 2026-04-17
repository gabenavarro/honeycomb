"""Tests for the in-memory AgentRegistry used by the M4 reverse tunnel."""

from __future__ import annotations

import asyncio

import pytest

from hub.models.agent_protocol import DoneFrame
from hub.services.agent_registry import AgentConnection, AgentRegistry


class FakeWebSocket:
    """Minimal stand-in for fastapi.WebSocket that records sent payloads."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed: bool = False

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000) -> None:  # pragma: no cover - unused
        self.closed = True


@pytest.mark.asyncio
async def test_register_then_get_returns_the_same_connection() -> None:
    reg = AgentRegistry()
    ws = FakeWebSocket()
    conn = await reg.register("c1", ws)
    assert reg.get("c1") is conn
    assert reg.has_live_connection("c1") is True


@pytest.mark.asyncio
async def test_register_evicts_prior_connection() -> None:
    reg = AgentRegistry()
    first = await reg.register("c1", FakeWebSocket())
    second = await reg.register("c1", FakeWebSocket())
    assert reg.get("c1") is second
    assert first.closed is True
    assert second.closed is False


@pytest.mark.asyncio
async def test_send_exec_serialises_to_cmd_exec_frame() -> None:
    reg = AgentRegistry()
    ws = FakeWebSocket()
    conn: AgentConnection = await reg.register("c1", ws)
    await conn.send_exec("abc", "echo hi", env={"A": "b"}, timeout_s=5.0)
    assert ws.sent == [
        {
            "type": "cmd_exec",
            "command_id": "abc",
            "command": "echo hi",
            "env": {"A": "b"},
            "timeout_s": 5.0,
        }
    ]


@pytest.mark.asyncio
async def test_duplicate_command_id_rejected() -> None:
    reg = AgentRegistry()
    conn = await reg.register("c1", FakeWebSocket())
    await conn.send_exec("abc", "echo hi")
    with pytest.raises(RuntimeError):
        await conn.send_exec("abc", "echo again")


@pytest.mark.asyncio
async def test_deliver_done_resolves_pending_future() -> None:
    reg = AgentRegistry()
    conn = await reg.register("c1", FakeWebSocket())
    pending = await conn.send_exec("abc", "echo hi")
    conn.deliver_done(DoneFrame(command_id="abc", exit_code=0, reason="completed"))
    done = await asyncio.wait_for(pending.done, timeout=1.0)
    assert done.exit_code == 0


@pytest.mark.asyncio
async def test_output_is_forwarded_to_queue() -> None:
    reg = AgentRegistry()
    conn = await reg.register("c1", FakeWebSocket())
    pending = await conn.send_exec("abc", "echo hi")
    conn.deliver_output("abc", "stdout", "chunk-1")
    conn.deliver_output("abc", "stdout", "chunk-2")
    stream, text = await pending.output.get()
    assert (stream, text) == ("stdout", "chunk-1")
    stream, text = await pending.output.get()
    assert (stream, text) == ("stdout", "chunk-2")


@pytest.mark.asyncio
async def test_close_fails_in_flight_commands() -> None:
    reg = AgentRegistry()
    conn = await reg.register("c1", FakeWebSocket())
    pending = await conn.send_exec("abc", "sleep 30")
    await conn.close(reason="test")
    with pytest.raises(RuntimeError):
        await asyncio.wait_for(pending.done, timeout=1.0)
    assert conn.closed is True


@pytest.mark.asyncio
async def test_deregister_only_removes_matching_connection() -> None:
    reg = AgentRegistry()
    first = await reg.register("c1", FakeWebSocket())
    # A stale handler tries to remove a connection that's already been
    # replaced. Registry should refuse to evict the fresh one.
    second = await reg.register("c1", FakeWebSocket())
    await reg.deregister("c1", first)
    assert reg.get("c1") is second
    # But the real handler's deregister call does land.
    await reg.deregister("c1", second)
    assert reg.get("c1") is None


@pytest.mark.asyncio
async def test_close_all_closes_every_connection() -> None:
    reg = AgentRegistry()
    conn1 = await reg.register("c1", FakeWebSocket())
    conn2 = await reg.register("c2", FakeWebSocket())
    await reg.close_all()
    assert conn1.closed is True
    assert conn2.closed is True
    assert reg.get("c1") is None
    assert reg.get("c2") is None


@pytest.mark.asyncio
async def test_snapshot_returns_connection_summary() -> None:
    reg = AgentRegistry()
    await reg.register("c1", FakeWebSocket())
    await reg.register("c2", FakeWebSocket())
    snap = reg.snapshot()
    cids = sorted(entry["container_id"] for entry in snap)
    assert cids == ["c1", "c2"]
    for entry in snap:
        assert "connected_for_s" in entry
        assert "pending_commands" in entry
