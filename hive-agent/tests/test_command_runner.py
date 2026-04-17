"""Tests for hive_agent.command_runner.CommandRunner."""

from __future__ import annotations

import asyncio

import pytest
from hive_agent.command_runner import CommandRunner


@pytest.mark.asyncio
async def test_run_captures_stdout() -> None:
    captured: list[tuple[str, str, str]] = []

    async def sink(command_id: str, stream: str, text: str) -> None:
        captured.append((command_id, stream, text))

    runner = CommandRunner(line_callback=sink)
    info = await runner.run("echo hello", command_id="c1")
    rc = await runner.wait("c1")

    assert rc == 0
    assert info["command_id"] == "c1"
    assert isinstance(info["pid"], int)
    stdout_lines = [t for cid, s, t in captured if cid == "c1" and s == "stdout"]
    assert any("hello" in line for line in stdout_lines)


@pytest.mark.asyncio
async def test_exit_event_carries_returncode() -> None:
    events: list[tuple[str, str]] = []

    async def sink(command_id: str, stream: str, text: str) -> None:
        events.append((stream, text.strip()))

    runner = CommandRunner(line_callback=sink)
    await runner.run("exit 3", command_id="c2")
    rc = await runner.wait("c2")
    assert rc == 3
    exits = [t for s, t in events if s == "exit"]
    assert exits == ["3"]


@pytest.mark.asyncio
async def test_kill_running_process() -> None:
    runner = CommandRunner()
    await runner.run("sleep 30", command_id="c3")
    await asyncio.sleep(0.1)
    assert runner.is_running("c3") is True
    killed = await runner.kill("c3")
    assert killed is True
    # After kill the collector task finishes; wait() returns the signal code.
    rc = await runner.wait("c3")
    assert rc != 0


@pytest.mark.asyncio
async def test_kill_unknown_command_returns_false() -> None:
    runner = CommandRunner()
    assert await runner.kill("does-not-exist") is False


@pytest.mark.asyncio
async def test_cleanup_frees_state() -> None:
    runner = CommandRunner()
    await runner.run("echo x", command_id="c4")
    await runner.wait("c4")
    runner.cleanup("c4")
    assert runner.get_output("c4") == []
    assert runner.returncode("c4") is None
