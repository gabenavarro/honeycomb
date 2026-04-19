"""Container filesystem browse helpers (M17).

The hub exposes two read-only views over a container's filesystem:

- ``WORKDIR`` — the container's configured working directory, free from
  ``container.attrs["Config"]["WorkingDir"]`` without a ``docker exec``.
- Directory listing — runs ``ls -A --full-time -- <path>`` inside the
  container, parses the output, and returns entries the dashboard can
  render as a tree.

Shell safety is paramount: the caller-supplied path is validated up
front (absolute, no shell metacharacters) and never string-interpolated
into a shell command. ``docker exec`` takes an argv list.

The ``ls`` parse is deliberately permissive about column widths — GNU
coreutils prints ``ls -lA --full-time``-style output as::

    drwxr-xr-x 2 root root 4096 2026-04-17 09:15:02.123456789 +0000 .hive
    -rw-r--r-- 1 root root  312 2026-04-17 09:15:02.123456789 +0000 README.md
    lrwxrwxrwx 1 root root    9 2026-04-17 09:15:02.123456789 +0000 link -> target

We split on runs of whitespace, read the last 9 tokens off the front
(mode, nlink, user, group, size, date, time, tz), and treat the rest
as the filename. That makes names with single spaces work; filenames
with embedded newlines are not supported (callers shouldn't be putting
those in a web UI anyway).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

EntryKind = Literal["file", "dir", "symlink", "other"]


# Hard cap on directory entries we return. 1000 is large enough for the
# conceivable "project root" listing while bounding the dashboard payload.
MAX_ENTRIES = 1000

# File-read caps (M18). Text content ships back as a string up to 5 MiB;
# binary files up to 1 MiB (base64 inflates that to ~1.33 MiB on the
# wire, which is the real ceiling). Anything bigger returns
# ``truncated=true`` with no body — the client offers a download link.
MAX_TEXT_BYTES = 5 * 1024 * 1024
MAX_BINARY_BYTES = 1 * 1024 * 1024

# MIME prefixes we treat as "text-like" and decode as UTF-8 for the
# dashboard's text viewer. Everything else ships as base64.
_TEXT_MIME_PREFIXES: tuple[str, ...] = (
    "text/",
    "application/json",
    "application/javascript",
    "application/xml",
    "application/x-sh",
    "application/x-yaml",
    "application/toml",
    "application/x-ipynb+json",
)


def is_text_mime(mime: str) -> bool:
    """Whether the given MIME type should be decoded as UTF-8 text."""
    lowered = (mime or "").lower()
    return any(lowered.startswith(prefix) for prefix in _TEXT_MIME_PREFIXES)


# Reject shell metacharacters in the path. Even though ``docker exec``
# with an argv list doesn't interpret them, accepting them makes
# downstream integration (logs, URLs) messy and invites bugs. The
# allowed set matches typical POSIX path characters.
_PATH_BAD_CHARS = re.compile(r"[\n\r\x00;&|`$<>*?{}\[\]\"']")


class InvalidFsPath(ValueError):
    """Raised when the caller-supplied path fails validation."""


def validate_path(path: str) -> str:
    """Return the path, stripped + validated. Raises ``InvalidFsPath``
    on anything the endpoint should reject with 400 before the ``docker
    exec`` round-trip happens."""
    stripped = (path or "").strip()
    if not stripped:
        raise InvalidFsPath("path is empty")
    if not stripped.startswith("/"):
        raise InvalidFsPath("path must be absolute (start with '/')")
    if _PATH_BAD_CHARS.search(stripped):
        raise InvalidFsPath("path contains disallowed characters")
    if ".." in stripped.split("/"):
        raise InvalidFsPath("path must not contain '..' segments")
    return stripped


@dataclass(frozen=True, slots=True)
class Entry:
    name: str
    kind: EntryKind
    size: int
    mode: str
    mtime: str  # ISO-8601 without timezone, close enough for display
    target: str | None  # for symlinks

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "size": self.size,
            "mode": self.mode,
            "mtime": self.mtime,
            "target": self.target,
        }


@dataclass(frozen=True, slots=True)
class DirectoryListing:
    path: str
    entries: list[Entry]
    truncated: bool

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "entries": [e.to_dict() for e in self.entries],
            "truncated": self.truncated,
        }


def parse_ls_output(output: str, *, max_entries: int = MAX_ENTRIES) -> tuple[list[Entry], bool]:
    """Turn ``ls -lA --full-time`` output into a list of Entry records.

    Returns ``(entries, truncated)`` where ``truncated`` is True if the
    input held more rows than ``max_entries``.

    Skip conditions (silent — these aren't errors):
    - ``total N`` summary line at the top
    - lines shorter than 9 tokens (malformed)

    For symlinks the filename is the portion before `` -> ``; the target
    follows.
    """
    entries: list[Entry] = []
    total_seen = 0
    for raw in output.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        if line.startswith("total "):
            # ``ls -l`` prepends this; GNU omits it with -A in some
            # locales, so we tolerate both cases by skipping when seen.
            continue
        total_seen += 1
        if len(entries) >= max_entries:
            # Keep counting so we can report truncation but stop parsing.
            continue
        parts = line.split(maxsplit=8)
        if len(parts) < 9:
            continue
        mode, _nlink, _user, _group, size_s, date_s, time_s, _tz, name_part = parts
        try:
            size = int(size_s)
        except ValueError:
            continue

        target: str | None = None
        name = name_part
        if " -> " in name_part:
            name, target = name_part.split(" -> ", 1)

        kind: EntryKind
        first = mode[:1]
        if first == "d":
            kind = "dir"
        elif first == "l":
            kind = "symlink"
        elif first == "-":
            kind = "file"
        else:
            kind = "other"

        mtime = f"{date_s} {time_s}".split(".", 1)[0]  # drop nanoseconds

        entries.append(
            Entry(name=name, kind=kind, size=size, mode=mode, mtime=mtime, target=target)
        )

    truncated = total_seen > max_entries
    return entries, truncated


# --- M23: flat filesystem walk for the palette's file-index ---


# Dirs we prune by default so the walker ignores the usual junk. Users
# can override via the endpoint's ``excludes`` query param. Names are
# matched against ``find``'s ``-name`` which matches basenames, so no
# glob weirdness creeps in.
DEFAULT_WALK_EXCLUDES: tuple[str, ...] = (
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    ".cache",
    ".pytest_cache",
)

# Walk response caps. `max_entries` keeps the payload bounded;
# `max_depth` stops a stray `/` root from traversing the whole host.
MAX_WALK_ENTRIES = 5_000
MAX_WALK_DEPTH = 8
_WALK_ENTRY_CEILING = 20_000
_WALK_DEPTH_CEILING = 16


def validate_walk_params(*, max_entries: int, max_depth: int) -> tuple[int, int]:
    """Return ``(max_entries, max_depth)`` after range-checking. Raises
    ``InvalidFsPath`` (reused as the single 400-producing exception)
    on values the endpoint should reject."""
    if max_entries < 1 or max_entries > _WALK_ENTRY_CEILING:
        raise InvalidFsPath(f"max_entries must be between 1 and {_WALK_ENTRY_CEILING}")
    if max_depth < 1 or max_depth > _WALK_DEPTH_CEILING:
        raise InvalidFsPath(f"max_depth must be between 1 and {_WALK_DEPTH_CEILING}")
    return max_entries, max_depth


def build_find_argv(
    root: str,
    excludes: tuple[str, ...],
    *,
    max_depth: int,
) -> list[str]:
    """Compose the `find` argv for a single-shot flat walk.

    Output format is ``%y\\t%s\\t%P\\n`` — kind (d/f/l/…) + size +
    relative path. No shell string interpolation anywhere; every
    excluded name is its own argv token.
    """
    argv: list[str] = ["find", root, "-maxdepth", str(max_depth)]
    if excludes:
        argv.append("(")
        first = True
        for name in excludes:
            if not first:
                argv.append("-o")
            argv.extend(["-name", name])
            first = False
        argv.extend([")", "-prune", "-o"])
    # ``-printf`` is a GNU extension; Alpine/busybox ``find`` lacks it.
    # ``walk_paths`` falls back to an ``ls``-based walk if needed — but
    # BusyBox's ``find`` doesn't print types, so we accept the loss:
    # the endpoint ships an empty entries list + ``elapsed_ms`` so the
    # UI can explain. See ``walk_paths`` for the exec_run flow.
    argv.extend(["-printf", "%y\t%s\t%P\n"])
    return argv


_KIND_MAP = {
    "d": "dir",
    "f": "file",
    "l": "symlink",
}


def parse_find_output(
    output: str,
    *,
    root: str,
    max_entries: int,
) -> tuple[list[Entry], bool]:
    """Turn the `find -printf` output into entries. Returns
    ``(entries, truncated)``.

    The root itself appears as an empty relative path — we skip it so
    the client never sees a path equal to ``root`` as its own entry.
    """
    entries: list[Entry] = []
    total = 0
    for raw in output.splitlines():
        line = raw.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t", 2)
        if len(parts) < 3:
            continue
        kind_char, size_s, rel = parts
        if rel == "":
            # Root entry — skip.
            continue
        total += 1
        if len(entries) >= max_entries:
            continue
        try:
            size = int(size_s)
        except ValueError:
            continue
        kind = _KIND_MAP.get(kind_char, "other")
        abs_path = f"{root.rstrip('/')}/{rel}"
        entries.append(
            Entry(
                name=abs_path,
                kind=kind,  # type: ignore[arg-type]
                size=size,
                mode="",
                mtime="",
                target=None,
            )
        )
    return entries, total > max_entries
