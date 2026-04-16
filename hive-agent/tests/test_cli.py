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
        assert "--port" in result.output
        assert "--hub-url" in result.output
        assert "--heartbeat-interval" in result.output
        assert "--daemon" in result.output

    def test_status_help(self) -> None:
        runner = CliRunner()
        result = runner.invoke(main, ["status", "--help"])
        assert result.exit_code == 0
        assert "--port" in result.output
