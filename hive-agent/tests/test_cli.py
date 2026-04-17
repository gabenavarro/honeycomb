"""Tests for the hive-agent CLI."""

from __future__ import annotations

from click.testing import CliRunner
from hive_agent.cli import main


class TestCLI:
    def test_help(self) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["--help"])
        assert result.exit_code == 0
        assert "Claude Hive Agent" in result.output

    def test_start_help(self) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["start", "--help"])
        assert result.exit_code == 0
        assert "--hub-url" in result.output
        assert "--container-id" in result.output
        assert "--heartbeat-interval" in result.output
        assert "--daemon" in result.output
        # Post-M4 the agent has no listener port to configure.
        assert "--port" not in result.output

    def test_status_help(self) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["status", "--help"])
        assert result.exit_code == 0
        # Post-M4 `status` just reports whether a process is alive;
        # no port option remains.
        assert "--port" not in result.output
