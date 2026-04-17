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
