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

import base64
import io
import re
import tarfile
import threading
import time as _time
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


class WalkError(RuntimeError):
    """Raised when `find` exits non-zero inside the container. The
    stderr/stdout blob is propagated as the exception message so the
    router can surface it verbatim."""


class WalkTimeout(TimeoutError):
    """Raised when the walk exceeds its wall-clock budget. The router
    translates this into 504 with a structured body."""


@dataclass(frozen=True, slots=True)
class WalkResultData:
    """Internal return shape. The router wraps this into the Pydantic
    ``WalkResult`` for JSON serialisation."""

    root: str
    entries: list[Entry]
    truncated: bool
    elapsed_ms: int

    def to_dict(self) -> dict:
        return {
            "root": self.root,
            "entries": [e.to_dict() for e in self.entries],
            "truncated": self.truncated,
            "elapsed_ms": self.elapsed_ms,
        }


def walk_paths(
    container,
    *,
    root: str,
    excludes: tuple[str, ...],
    max_entries: int,
    max_depth: int,
    timeout_s: float = 10.0,
) -> WalkResultData:
    """Run ``find`` inside the container and return parsed entries.

    Wall-clock timeout is enforced via a worker thread: ``docker-py``'s
    ``exec_run`` is blocking with no native deadline, and the walk path
    is rare enough that one throwaway thread per call is fine.
    """
    argv = build_find_argv(root, excludes, max_depth=max_depth)

    result: dict[str, object] = {}

    def _run() -> None:
        try:
            ec, out = container.exec_run(argv, tty=False, demux=False)
            result["ec"] = ec
            result["out"] = out
        except Exception as exc:
            result["exc"] = exc

    start = _time.monotonic()
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout_s)
    if t.is_alive():
        raise WalkTimeout(f"walk timed out after {timeout_s}s for {root}")
    elapsed_ms = int((_time.monotonic() - start) * 1000)

    if "exc" in result:
        raise WalkError(str(result["exc"]))
    ec = result.get("ec", 1)
    out = result.get("out", b"")
    if ec != 0:
        text = out.decode("utf-8", errors="replace") if isinstance(out, bytes) else str(out or "")
        raise WalkError(text.strip() or f"find exited with {ec}")

    text = out.decode("utf-8", errors="replace") if isinstance(out, bytes) else str(out)
    entries, truncated = parse_find_output(text, root=root, max_entries=max_entries)
    return WalkResultData(
        root=root,
        entries=entries,
        truncated=truncated,
        elapsed_ms=elapsed_ms,
    )


# --- M24: write-back editing ---


MAX_WRITE_BYTES = 5 * 1024 * 1024


class FileNotFound(RuntimeError):
    """Raised when the target file doesn't exist at write time. The
    router translates this into 404 (overwrite-only contract)."""


class WriteConflict(RuntimeError):
    """Raised when the on-disk mtime differs from the client's
    ``if_match_mtime_ns`` echo. The router translates into 409 and
    includes ``current_mtime_ns`` in the response body so the client
    can offer a 'Save anyway' affordance without a second round trip."""

    def __init__(self, current_mtime_ns: int) -> None:
        super().__init__("File changed on disk")
        self.current_mtime_ns = current_mtime_ns


class WriteTooLarge(RuntimeError):
    """Raised when the decoded payload exceeds ``MAX_WRITE_BYTES``.
    Router → 413."""


class WriteError(RuntimeError):
    """Raised when ``put_archive`` signals failure (permission denied,
    read-only bind mount, docker daemon hiccup). Router → 502 with the
    error message propagated verbatim."""


def parse_stat_size_mtime(raw: str) -> tuple[int, int]:
    """Parse ``stat -c '%s|%Y.%N'`` output into ``(size, mtime_ns)``.

    The format is deliberately unusual — ``%s`` is bytes, ``%Y`` is
    seconds-since-epoch, ``%N`` is nanoseconds (GNU coreutils
    extension). We combine ``%Y`` + ``%N`` into a single nanosecond
    integer so the client can echo it back verbatim.
    """
    if "|" not in raw:
        raise ValueError(f"expected 'size|secs.nanos', got {raw!r}")
    size_s, secs_nanos = raw.strip().split("|", 1)
    size = int(size_s)
    # ``%N`` is nine digits; pad with zeros if upstream rounded.
    if "." not in secs_nanos:
        secs, nanos = secs_nanos, "0"
    else:
        secs, nanos = secs_nanos.split(".", 1)
    nanos = (nanos + "000000000")[:9]
    mtime_ns = int(secs) * 1_000_000_000 + int(nanos)
    return size, mtime_ns


def parse_stat_mode_ownership(raw: str) -> tuple[int, int, int]:
    """Parse ``stat -c '%a|%u|%g'`` into ``(mode, uid, gid)``.

    ``%a`` is octal permissions without the leading ``0o``. We accept
    three- or four-digit values (setuid/setgid/sticky prefix).
    """
    parts = raw.strip().split("|")
    if len(parts) != 3:
        raise ValueError(f"expected 'mode|uid|gid', got {raw!r}")
    mode_s, uid_s, gid_s = parts
    mode = int(mode_s, 8)
    return mode, int(uid_s), int(gid_s)


def decode_write_payload(
    *,
    content: str | None,
    content_base64: str | None,
) -> bytes:
    """Validate + decode the FileWriteRequest body into raw bytes.

    Exactly one of ``content`` / ``content_base64`` must be set. Raises
    ``InvalidFsPath`` (re-used as the 400-mapping exception) on both-
    or-neither; ``WriteTooLarge`` if the decoded payload exceeds the
    5 MiB cap.
    """
    if content is not None and content_base64 is not None:
        raise InvalidFsPath("set exactly one of content / content_base64, not both")
    if content is None and content_base64 is None:
        raise InvalidFsPath("set exactly one of content / content_base64")
    if content is not None:
        data = content.encode("utf-8")
    else:
        try:
            data = base64.b64decode(content_base64 or "", validate=True)
        except (ValueError, _binascii_error()) as exc:
            raise InvalidFsPath(f"content_base64 is not valid base64: {exc}") from exc
    if len(data) > MAX_WRITE_BYTES:
        raise WriteTooLarge(f"payload is {len(data)} bytes, exceeds {MAX_WRITE_BYTES}-byte cap")
    return data


def _binascii_error() -> type[BaseException]:
    """Return the Error class of ``binascii`` without importing it at
    module load — keeps import time tight."""
    import binascii

    return binascii.Error


def build_write_tar(
    basename: str,
    content: bytes,
    mode: int,
    uid: int,
    gid: int,
) -> bytes:
    """Build an in-memory tar holding a single file entry.

    ``docker-py``'s ``container.put_archive(path=parent_dir, data=...)``
    expects a tar stream. We use ``PAX_FORMAT`` so large files and
    non-ASCII filenames survive the round trip; the Docker daemon
    accepts all three format flavours in practice but PAX is the most
    forward-compatible.
    """
    info = tarfile.TarInfo(name=basename)
    info.size = len(content)
    info.mode = mode
    info.uid = uid
    info.gid = gid
    info.mtime = int(_time.time())
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        tf.addfile(info, io.BytesIO(content))
    return buf.getvalue()


@dataclass(frozen=True, slots=True)
class WriteResultData:
    """Return shape from ``write_file``. The router wraps this +
    the client-submitted content into the ``FileContent`` response."""

    path: str
    size: int
    mtime_ns: int

    def to_dict(self) -> dict:
        return {"path": self.path, "size": self.size, "mtime_ns": self.mtime_ns}


def write_file(
    container,
    *,
    path: str,
    payload: bytes,
    if_match_mtime_ns: int,
) -> WriteResultData:
    """Atomically replace ``path`` inside the container with
    ``payload``.

    Steps: stat the existing file (404 if absent, 409 on mtime
    mismatch), read its mode/uid/gid, build a single-entry tar,
    ``put_archive`` the tar into the parent directory, and re-stat
    to produce the post-write mtime.
    """
    # Pre-write stat — gets size + mtime.
    ec, out = container.exec_run(["stat", "-c", "%s|%Y.%N", "--", path], tty=False, demux=False)
    text = out.decode("utf-8", errors="replace") if isinstance(out, bytes) else str(out or "")
    if ec != 0:
        raise FileNotFound(text.strip() or f"stat exited with {ec}")
    try:
        _current_size, current_mtime_ns = parse_stat_size_mtime(text)
    except ValueError as exc:
        raise WriteError(f"unparseable stat output: {text!r}") from exc
    if current_mtime_ns != if_match_mtime_ns:
        raise WriteConflict(current_mtime_ns)

    # Mode / uid / gid — copied into the tar header so the written
    # file inherits the original ownership bits.
    ec2, out2 = container.exec_run(["stat", "-c", "%a|%u|%g", "--", path], tty=False, demux=False)
    text2 = out2.decode("utf-8", errors="replace") if isinstance(out2, bytes) else str(out2 or "")
    if ec2 != 0:
        raise WriteError(text2.strip() or f"stat-mode exited with {ec2}")
    try:
        mode, uid, gid = parse_stat_mode_ownership(text2)
    except ValueError as exc:
        raise WriteError(f"unparseable mode/uid/gid: {text2!r}") from exc

    # Split path into parent + basename for put_archive.
    parent = path.rsplit("/", 1)[0] or "/"
    basename = path.rsplit("/", 1)[-1]
    tar_bytes = build_write_tar(basename, payload, mode, uid, gid)

    ok = container.put_archive(path=parent, data=tar_bytes)
    if not ok:
        raise WriteError("put_archive returned falsy")

    # Post-write stat — surfaces the new mtime/size.
    ec3, out3 = container.exec_run(["stat", "-c", "%s|%Y.%N", "--", path], tty=False, demux=False)
    text3 = out3.decode("utf-8", errors="replace") if isinstance(out3, bytes) else str(out3 or "")
    if ec3 != 0:
        raise WriteError(text3.strip() or f"post-stat exited with {ec3}")
    try:
        new_size, new_mtime_ns = parse_stat_size_mtime(text3)
    except ValueError as exc:
        raise WriteError(f"unparseable post-stat output: {text3!r}") from exc

    return WriteResultData(path=path, size=new_size, mtime_ns=new_mtime_ns)
