"""Tests for hub.services.tool_probe.

Everything here patches asyncio subprocess creation so we don't depend
on a running Docker daemon. Probe semantics are narrow:
  - rc == 0  → True  (claude resolved in the container)
  - rc != 0  → False (claude not found)
  - timeout  → False (slow container treated as missing — avoids
               blocking the UI while the user stares at a spinner)
  - no docker binary on PATH → False
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import asyncio

import pytest

from hub.services.tool_probe import has_claude_cli


def _fake_proc(returncode: int | None, *, hang: bool = False) -> MagicMock:
    proc = MagicMock()
    proc.returncode = returncode
    if hang:
        async def never_return() -> int:
            await asyncio.sleep(10)
            return 0
        proc.wait = AsyncMock(side_effect=never_return)
    else:
        proc.wait = AsyncMock(return_value=returncode or 0)
    proc.kill = MagicMock()
    return proc


@pytest.mark.asyncio
async def test_returns_true_when_claude_resolves() -> None:
    with patch(
        "hub.services.tool_probe.asyncio.create_subprocess_exec",
        AsyncMock(return_value=_fake_proc(0)),
    ):
        assert await has_claude_cli("cid") is True


@pytest.mark.asyncio
async def test_returns_false_when_claude_missing() -> None:
    with patch(
        "hub.services.tool_probe.asyncio.create_subprocess_exec",
        AsyncMock(return_value=_fake_proc(1)),
    ):
        assert await has_claude_cli("cid") is False


@pytest.mark.asyncio
async def test_returns_false_on_timeout_and_kills_process() -> None:
    proc = _fake_proc(None, hang=True)
    with patch(
        "hub.services.tool_probe.asyncio.create_subprocess_exec",
        AsyncMock(return_value=proc),
    ):
        result = await has_claude_cli("cid", timeout=0.05)
    assert result is False
    proc.kill.assert_called_once()


@pytest.mark.asyncio
async def test_returns_false_when_docker_binary_missing() -> None:
    with patch(
        "hub.services.tool_probe.asyncio.create_subprocess_exec",
        AsyncMock(side_effect=FileNotFoundError),
    ):
        assert await has_claude_cli("cid") is False
