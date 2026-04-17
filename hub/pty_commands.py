"""Allowlist of commands the PTY endpoint will launch.

Pre-M5 the ``cmd`` query param on ``/ws/pty/{record_id}`` was passed
through ``.strip().lower()`` and then f-string-interpolated into
``sh -c "exec <cmd>"``. That let a caller drive ``sh -c`` with shell
metacharacters — ``?cmd=;rm -rf /`` would actually execute that string
inside the container. This module replaces that path with a static
mapping from a short set of symbolic names to fixed ``argv`` lists.
Unknown values are rejected at the router instead of silently running.

Each command resolves to a sequence of strings that gets handed to
``docker exec`` without shell interpretation — the closest thing to
``execve`` semantics we have from Python. When we do need ``sh -c``
for a login-shell experience, the argument is a constant string (never
user-controlled) and takes no variables.

Adding a new entry
------------------
Add a member to :class:`PtyCommand`, map it in :data:`COMMAND_ARGVS`,
and add a matching symbolic alias if the UI uses a friendlier name
(e.g. "bash" aliased to :class:`PtyCommand.SHELL`). The accompanying
test (``hub/tests/test_pty_commands.py``) iterates every member so
forgetting the mapping fails loudly.

The dashboard continues to send the pre-M5 strings (``bash`` / ``sh``
/ ``claude``) — those map cleanly through :data:`COMMAND_ALIASES` so no
coordinated frontend change is required.
"""

from __future__ import annotations

from enum import StrEnum


class PtyCommand(StrEnum):
    """Every program the PTY endpoint is allowed to launch."""

    SHELL = "shell"  # bash -l with sh -l fallback
    SH = "sh"  # sh -l
    CLAUDE = "claude"  # exec claude (interactive REPL + slash commands)
    PYTHON = "python"  # exec python3 (falls back to python)
    NODE = "node"
    PYTEST = "pytest"
    GIT = "git"
    UV = "uv"


# Canonical argv per command. Values are passed to the container's PTY
# verbatim; nothing here is interpolated with user input.
COMMAND_ARGVS: dict[PtyCommand, list[str]] = {
    # ``bash -l`` loads ``/etc/profile`` + ``~/.bashrc`` so HIVE_* and
    # project PATH entries land as expected. The ``|| exec sh -l`` tail
    # catches Alpine-flavoured images that omit bash.
    PtyCommand.SHELL: [
        "sh",
        "-c",
        "command -v bash >/dev/null && exec bash -l || exec sh -l",
    ],
    PtyCommand.SH: ["sh", "-l"],
    PtyCommand.CLAUDE: ["sh", "-c", "exec claude"],
    # Prefer python3 — python on fresh Debian images is often the
    # "unversioned-python" stub. Fall back silently via ``command -v``.
    PtyCommand.PYTHON: [
        "sh",
        "-c",
        "command -v python3 >/dev/null && exec python3 || exec python",
    ],
    PtyCommand.NODE: ["sh", "-c", "exec node"],
    PtyCommand.PYTEST: ["sh", "-c", "exec pytest"],
    PtyCommand.GIT: ["sh", "-c", "exec git"],
    PtyCommand.UV: ["sh", "-c", "exec uv"],
}


# Aliases accept the human-friendly names the dashboard has been
# sending since the pre-M5 era. ``bash`` was the old default for the
# shell tab, ``""`` fell through to the same path. Both now normalise
# onto :class:`PtyCommand.SHELL` before the enum lookup runs.
COMMAND_ALIASES: dict[str, PtyCommand] = {
    "": PtyCommand.SHELL,
    "bash": PtyCommand.SHELL,
    "shell": PtyCommand.SHELL,
    "sh": PtyCommand.SH,
    "claude": PtyCommand.CLAUDE,
    "python": PtyCommand.PYTHON,
    "python3": PtyCommand.PYTHON,
    "py": PtyCommand.PYTHON,
    "node": PtyCommand.NODE,
    "nodejs": PtyCommand.NODE,
    "pytest": PtyCommand.PYTEST,
    "git": PtyCommand.GIT,
    "uv": PtyCommand.UV,
}


class UnknownPtyCommand(ValueError):
    """Raised by :func:`resolve_command` when ``raw`` is not in the allowlist."""

    def __init__(self, raw: str) -> None:
        super().__init__(f"unknown pty command: {raw!r}")
        self.raw = raw


def resolve_command(raw: str | None) -> list[str]:
    """Return the fixed ``argv`` for a user-supplied ``cmd`` query param.

    Lookup is case-insensitive and strips whitespace. Raises
    :class:`UnknownPtyCommand` if ``raw`` isn't in the alias table; the
    caller should translate that into a 4400 close frame.
    """
    key = (raw or "").strip().lower()
    # Reject early on obvious shell metacharacters so a confused caller
    # gets a precise error instead of the generic "unknown command".
    if any(ch in key for ch in ";|&`$<>\\"):
        raise UnknownPtyCommand(raw or "")
    try:
        command = COMMAND_ALIASES[key]
    except KeyError as exc:
        raise UnknownPtyCommand(raw or "") from exc
    return list(COMMAND_ARGVS[command])


def allowed_aliases() -> list[str]:
    """Return the sorted list of aliases accepted by :func:`resolve_command`.

    Handy for the dashboard or a ``/api/pty/commands`` introspection
    endpoint; no caller uses it yet but it's cheap to expose.
    """
    return sorted(COMMAND_ALIASES)
