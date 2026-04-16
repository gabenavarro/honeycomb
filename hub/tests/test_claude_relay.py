"""Tests for the ClaudeRelay service helpers.

Exercises the pure-function bits (has_devcontainer_config) and the docker
exec path with patched asyncio subprocess calls. The agent HTTP paths are
covered by test_integration.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from hub.services.claude_relay import ClaudeRelay
from hub.services.devcontainer_manager import DevContainerManager


@pytest.fixture
def relay() -> ClaudeRelay:
    # DevContainerManager doesn't need real docker here — we only poke the
    # static helpers and the docker exec path.
    return ClaudeRelay(DevContainerManager())


class TestHasDevcontainerConfig:
    def test_true_when_devcontainer_json_present(self, tmp_path: Path) -> None:
        (tmp_path / ".devcontainer").mkdir()
        (tmp_path / ".devcontainer" / "devcontainer.json").write_text("{}")
        assert ClaudeRelay.has_devcontainer_config(str(tmp_path)) is True

    def test_false_when_missing(self, tmp_path: Path) -> None:
        assert ClaudeRelay.has_devcontainer_config(str(tmp_path)) is False

    def test_false_on_pseudo_workspace_path(self) -> None:
        # e.g. /workspace/gnbio from discovered ad-hoc containers.
        assert ClaudeRelay.has_devcontainer_config("/workspace/gnbio") is False

    def test_false_on_garbage_input(self) -> None:
        assert ClaudeRelay.has_devcontainer_config("") is False


class TestExecViaDocker:
    @pytest.mark.asyncio
    async def test_happy_path_bash(self, relay: ClaudeRelay) -> None:
        """Successful bash -lc path returns rc/stdout/stderr."""
        fake_proc = MagicMock()
        fake_proc.returncode = 0
        fake_proc.communicate = AsyncMock(return_value=(b"hello\n", b""))

        with patch(
            "hub.services.claude_relay.asyncio.create_subprocess_exec",
            AsyncMock(return_value=fake_proc),
        ) as mock_exec:
            rc, stdout, stderr = await relay.exec_via_docker("cid123", "echo hello")

        assert rc == 0
        assert stdout == "hello\n"
        assert stderr == ""
        # First invocation should be bash -lc
        args, _ = mock_exec.call_args
        assert args[:5] == ("docker", "exec", "-i", "cid123", "bash")

    @pytest.mark.asyncio
    async def test_falls_back_to_sh_when_bash_missing_on_stderr(self, relay: ClaudeRelay) -> None:
        """Some container shells put the bash-missing message on stderr."""
        first_proc = MagicMock()
        first_proc.returncode = 127
        first_proc.communicate = AsyncMock(return_value=(b"", b"exec: bash: not found\n"))
        second_proc = MagicMock()
        second_proc.returncode = 0
        second_proc.communicate = AsyncMock(return_value=(b"sh-output\n", b""))

        with patch(
            "hub.services.claude_relay.asyncio.create_subprocess_exec",
            AsyncMock(side_effect=[first_proc, second_proc]),
        ) as mock_exec:
            rc, stdout, _ = await relay.exec_via_docker("cid123", "ls")

        assert rc == 0
        assert stdout == "sh-output\n"
        assert mock_exec.call_count == 2
        second_args, _ = mock_exec.call_args_list[1]
        assert second_args[:4] == ("docker", "exec", "-i", "cid123")
        assert second_args[4] == "sh"

    @pytest.mark.asyncio
    async def test_falls_back_to_sh_when_bash_missing_on_stdout(self, relay: ClaudeRelay) -> None:
        """Docker itself sometimes reports exec failures on stdout (e.g.
        Alpine via docker 28.x). Retry must also trigger on stdout hits."""
        first_proc = MagicMock()
        first_proc.returncode = 127
        first_proc.communicate = AsyncMock(
            return_value=(
                b'OCI runtime exec failed: exec: "bash": executable file not found in $PATH\n',
                b"",
            )
        )
        second_proc = MagicMock()
        second_proc.returncode = 0
        second_proc.communicate = AsyncMock(return_value=(b"alpine\n", b""))

        with patch(
            "hub.services.claude_relay.asyncio.create_subprocess_exec",
            AsyncMock(side_effect=[first_proc, second_proc]),
        ) as mock_exec:
            rc, stdout, _ = await relay.exec_via_docker("cid123", "whoami")

        assert rc == 0
        assert stdout == "alpine\n"
        assert mock_exec.call_count == 2

    @pytest.mark.asyncio
    async def test_nonzero_exit_is_preserved(self, relay: ClaudeRelay) -> None:
        fake_proc = MagicMock()
        fake_proc.returncode = 2
        fake_proc.communicate = AsyncMock(return_value=(b"", b"no such file\n"))

        with patch(
            "hub.services.claude_relay.asyncio.create_subprocess_exec",
            AsyncMock(return_value=fake_proc),
        ):
            rc, _, stderr = await relay.exec_via_docker("cid", "ls /missing")

        assert rc == 2
        assert "no such file" in stderr
