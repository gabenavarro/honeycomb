# M24 Implementation Plan — Write-back editing with CodeMirror 6 (textarea fallback)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add round-trip file editing to the Honeycomb dashboard — open a text file in the FileViewer, edit in a CodeMirror 6 editor (plain-textarea fallback on load failure), click Save, the file's bytes land inside the container via `container.put_archive()` guarded by an `mtime_ns` stale-write check.

**Architecture:** New `PUT /api/containers/{id}/fs/write` route in `hub/routers/fs.py`, backed by a `write_file()` helper in `hub/services/fs_browser.py` that stats the target, verifies `if_match_mtime_ns`, builds a single-entry tar in memory with the pre-existing mode/uid/gid, and uploads via `container.put_archive()`. Dashboard adds a new `<CodeEditor>` component wrapping `@codemirror/view`'s `EditorView` and extends `<FileViewer>` with edit-mode state, conflict banner, Save handler, and an `ErrorBoundary` fallback to a controlled `<textarea>` if CodeMirror fails to mount.

**Tech Stack:** FastAPI + docker-py (put_archive); CodeMirror 6 (state + view + commands + language packs + one-dark theme); React 19 + TanStack Query v5; pytest + httpx/ASGITransport + vitest + Playwright.

---

## File structure

### Created

- `hub/tests/test_fs_writer.py` — unit tests for pure write-side helpers (tar construction, stat parsing, size cap)
- `hub/tests/test_fs_write_endpoint.py` — route integration tests
- `dashboard/src/components/CodeEditor.tsx` — CodeMirror wrapper
- `dashboard/src/components/__tests__/CodeEditor.test.tsx` — vitest
- `dashboard/src/components/__tests__/FileViewer.test.tsx` — vitest for edit-mode flow
- `dashboard/tests/e2e/file-write.spec.ts` — Playwright round-trip

### Modified

- `hub/services/fs_browser.py` — new `write_file()` + exceptions + pure helpers
- `hub/routers/fs.py` — new `PUT /fs/write` route; mtime echo on read
- `hub/models/schemas.py` — `FileWriteRequest`; `FileContent.mtime_ns`
- `dashboard/src/lib/api.ts` — `writeContainerFile` wrapper
- `dashboard/src/lib/types.ts` — `FileWriteRequest` + `FileContent.mtime_ns`
- `dashboard/src/components/FileViewer.tsx` — edit mode, Save handler, conflict banner, dirty-state guard
- `dashboard/src/components/ErrorBoundary.tsx` — optional `fallback?: ReactNode` prop
- `dashboard/package.json` — CodeMirror 6 dep set

---

## Task 1: `FileWriteRequest` + `FileContent.mtime_ns` schemas

**Files:**

- Modify: `hub/models/schemas.py`

- [ ] **Step 1: Add `mtime_ns` to `FileContent` and `FileWriteRequest` after it.**

Open `hub/models/schemas.py`. Find the existing `FileContent` class (around line 176). Replace it with:

```python
class FileContent(BaseModel):
    """Body returned by ``GET /api/containers/{id}/fs/read``.

    The hub ships text files inline as UTF-8 ``content`` (up to
    5 MiB); binary files go through base64 (up to 1 MiB). Larger files
    return ``truncated=true`` with no body — the dashboard offers a
    download link instead of an inline preview.
    """

    path: str
    mime_type: str
    size_bytes: int
    # M24 — nanosecond-resolution mtime echoed back on every read so
    # the dashboard can guard against concurrent on-disk edits when it
    # later writes via PUT /fs/write. 0 when the stat call failed
    # (preserved for back-compat with the single "truncated" branch).
    mtime_ns: int = 0
    content: str | None = None
    content_base64: str | None = None
    truncated: bool = False
    error: str | None = None


class FileWriteRequest(BaseModel):
    """Body for ``PUT /api/containers/{id}/fs/write`` (M24).

    Exactly one of ``content`` / ``content_base64`` must be set. The
    ``if_match_mtime_ns`` echo comes from the most recent ``GET
    /fs/read`` — the hub refuses the write if the file on disk has
    changed since then (409).
    """

    path: str
    content: str | None = None
    content_base64: str | None = None
    if_match_mtime_ns: int
```

- [ ] **Step 2: Typecheck.**

Run: `cd hub && uv run mypy hub/models/schemas.py`
Expected: `Success: no issues found in 1 source file`.

- [ ] **Step 3: Commit.**

```bash
git add hub/models/schemas.py
git commit -m "feat(m24): FileWriteRequest + FileContent.mtime_ns"
```

---

## Task 2: Pure helpers — tar builder + stat parsers (TDD)

**Files:**

- Modify: `hub/services/fs_browser.py`
- Create: `hub/tests/test_fs_writer.py`

- [ ] **Step 1: Create `hub/tests/test_fs_writer.py` with failing tests.**

```python
"""Unit tests for write_file helpers (M24)."""

from __future__ import annotations

import io
import tarfile

import pytest

from hub.services.fs_browser import (
    MAX_WRITE_BYTES,
    InvalidFsPath,
    WriteTooLarge,
    build_write_tar,
    decode_write_payload,
    parse_stat_mode_ownership,
    parse_stat_size_mtime,
)


class TestParseStatSizeMtime:
    def test_happy_path(self) -> None:
        assert parse_stat_size_mtime("312|1234567890.123456789") == (312, 1234567890123456789)

    def test_zero_nanos(self) -> None:
        assert parse_stat_size_mtime("0|1234567890.000000000") == (0, 1234567890000000000)

    def test_rejects_missing_bar(self) -> None:
        with pytest.raises(ValueError):
            parse_stat_size_mtime("312 1234567890.1")

    def test_rejects_unparseable_size(self) -> None:
        with pytest.raises(ValueError):
            parse_stat_size_mtime("foo|1234567890.1")


class TestParseStatModeOwnership:
    def test_happy_path(self) -> None:
        assert parse_stat_mode_ownership("644|0|0") == (0o644, 0, 0)

    def test_three_digit_octal(self) -> None:
        assert parse_stat_mode_ownership("755|1000|1000") == (0o755, 1000, 1000)

    def test_four_digit_setuid(self) -> None:
        # setuid bits sometimes come through as 4755 etc.
        assert parse_stat_mode_ownership("4755|0|0") == (0o4755, 0, 0)

    def test_rejects_short(self) -> None:
        with pytest.raises(ValueError):
            parse_stat_mode_ownership("644|0")


class TestBuildWriteTar:
    def test_single_entry_with_mode(self) -> None:
        tar_bytes = build_write_tar(
            basename="hello.txt",
            content=b"hi there\n",
            mode=0o644,
            uid=1000,
            gid=1000,
        )
        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r") as tf:
            members = tf.getmembers()
            assert len(members) == 1
            m = members[0]
            assert m.name == "hello.txt"
            assert m.size == len(b"hi there\n")
            assert m.mode == 0o644
            assert m.uid == 1000
            assert m.gid == 1000
            f = tf.extractfile(m)
            assert f is not None
            assert f.read() == b"hi there\n"

    def test_empty_content_ok(self) -> None:
        tar_bytes = build_write_tar("empty", b"", 0o600, 0, 0)
        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r") as tf:
            [m] = tf.getmembers()
            assert m.size == 0


class TestDecodeWritePayload:
    def test_text_content(self) -> None:
        assert decode_write_payload(content="héllo", content_base64=None) == "héllo".encode()

    def test_base64_content(self) -> None:
        b64 = "aGVsbG8="  # "hello"
        assert decode_write_payload(content=None, content_base64=b64) == b"hello"

    def test_both_set_raises(self) -> None:
        with pytest.raises(InvalidFsPath):
            decode_write_payload(content="a", content_base64="aGVsbG8=")

    def test_neither_set_raises(self) -> None:
        with pytest.raises(InvalidFsPath):
            decode_write_payload(content=None, content_base64=None)

    def test_invalid_base64_raises(self) -> None:
        with pytest.raises(InvalidFsPath):
            decode_write_payload(content=None, content_base64="not valid!@#$%^&*")

    def test_size_cap(self) -> None:
        # One byte over the cap → WriteTooLarge.
        oversized = "a" * (MAX_WRITE_BYTES + 1)
        with pytest.raises(WriteTooLarge):
            decode_write_payload(content=oversized, content_base64=None)
```

- [ ] **Step 2: Run the tests — they fail (symbols not defined).**

Run: `cd hub && uv run pytest tests/test_fs_writer.py -v`
Expected: ImportError on `MAX_WRITE_BYTES`, `WriteTooLarge`, `build_write_tar`, `decode_write_payload`, `parse_stat_mode_ownership`, `parse_stat_size_mtime`.

- [ ] **Step 3: Append helpers to `hub/services/fs_browser.py` below `walk_paths`.**

Add to the imports block at the top (merge with existing):

```python
import base64
import io
import tarfile
import time as _time
```

(`tarfile` and `base64` are stdlib; `io` is stdlib; `_time` is already imported for walk timeout.)

Append at the end of the file:

```python
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
        raise WriteTooLarge(
            f"payload is {len(data)} bytes, exceeds {MAX_WRITE_BYTES}-byte cap"
        )
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
```

- [ ] **Step 4: Run the tests.**

Run: `cd hub && uv run pytest tests/test_fs_writer.py -v`
Expected: 14 passing.

- [ ] **Step 5: Commit.**

```bash
git add hub/services/fs_browser.py hub/tests/test_fs_writer.py
git commit -m "feat(m24): tar builder + stat parsers + write-payload decoder"
```

---

## Task 3: `write_file` coordinator (TDD)

**Files:**

- Modify: `hub/services/fs_browser.py`
- Modify: `hub/tests/test_fs_writer.py`

- [ ] **Step 1: Append failing test for `write_file` with a stubbed container.**

Add to `hub/tests/test_fs_writer.py`:

```python
from unittest.mock import MagicMock


class TestWriteFile:
    def _container(
        self,
        stat_responses: list[tuple[int, bytes]],
        put_archive_result: bool = True,
    ) -> MagicMock:
        """Return a container mock whose successive ``exec_run`` calls
        yield the given (exit_code, bytes) tuples and whose
        ``put_archive`` returns ``put_archive_result``."""
        container = MagicMock()
        container.exec_run = MagicMock(side_effect=stat_responses)
        container.put_archive = MagicMock(return_value=put_archive_result)
        return container

    def test_happy_path_text(self) -> None:
        from hub.services.fs_browser import write_file

        stat_responses = [
            # stat -c '%s|%Y.%N' — pre-write
            (0, b"100|1700000000.000000000"),
            # stat -c '%a|%u|%g'
            (0, b"644|0|0"),
            # stat -c '%s|%Y.%N' — post-write
            (0, b"200|1700000100.500000000"),
        ]
        container = self._container(stat_responses, put_archive_result=True)
        result = write_file(
            container,
            path="/workspace/foo.txt",
            payload=b"new content",
            if_match_mtime_ns=1_700_000_000_000_000_000,
        )
        assert result.path == "/workspace/foo.txt"
        assert result.size == 200
        assert result.mtime_ns == 1_700_000_100_500_000_000
        assert container.put_archive.called
        # put_archive target dir is the parent.
        (args, kwargs) = container.put_archive.call_args
        assert kwargs.get("path") == "/workspace"
        assert kwargs.get("data") or args[1]  # tar bytes present

    def test_file_not_found_raises(self) -> None:
        from hub.services.fs_browser import FileNotFound, write_file

        container = self._container(
            [(1, b"stat: cannot stat '/nope': No such file or directory\n")],
        )
        with pytest.raises(FileNotFound):
            write_file(
                container,
                path="/nope",
                payload=b"x",
                if_match_mtime_ns=0,
            )

    def test_mtime_mismatch_raises(self) -> None:
        from hub.services.fs_browser import WriteConflict, write_file

        container = self._container(
            [(0, b"100|1700000000.000000000")],
        )
        with pytest.raises(WriteConflict) as ei:
            write_file(
                container,
                path="/workspace/foo",
                payload=b"x",
                if_match_mtime_ns=1_699_000_000_000_000_000,
            )
        assert ei.value.current_mtime_ns == 1_700_000_000_000_000_000

    def test_put_archive_failure_raises(self) -> None:
        from hub.services.fs_browser import WriteError, write_file

        stat_responses = [
            (0, b"100|1700000000.000000000"),
            (0, b"644|0|0"),
        ]
        container = self._container(stat_responses, put_archive_result=False)
        with pytest.raises(WriteError):
            write_file(
                container,
                path="/workspace/foo",
                payload=b"x",
                if_match_mtime_ns=1_700_000_000_000_000_000,
            )
```

- [ ] **Step 2: Run — fails.**

Run: `cd hub && uv run pytest tests/test_fs_writer.py::TestWriteFile -v`
Expected: ImportError on `write_file`.

- [ ] **Step 3: Append `write_file` to `hub/services/fs_browser.py`.**

```python
@_dataclass(frozen=True, slots=True)
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
    ec, out = container.exec_run(
        ["stat", "-c", "%s|%Y.%N", "--", path], tty=False, demux=False
    )
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
    ec2, out2 = container.exec_run(
        ["stat", "-c", "%a|%u|%g", "--", path], tty=False, demux=False
    )
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
    ec3, out3 = container.exec_run(
        ["stat", "-c", "%s|%Y.%N", "--", path], tty=False, demux=False
    )
    text3 = out3.decode("utf-8", errors="replace") if isinstance(out3, bytes) else str(out3 or "")
    if ec3 != 0:
        raise WriteError(text3.strip() or f"post-stat exited with {ec3}")
    try:
        new_size, new_mtime_ns = parse_stat_size_mtime(text3)
    except ValueError as exc:
        raise WriteError(f"unparseable post-stat output: {text3!r}") from exc

    return WriteResultData(path=path, size=new_size, mtime_ns=new_mtime_ns)
```

Note: the existing `@_dataclass` import alias from Task 3 of M23 should already exist. If for any reason it was cleaned up, the existing `from dataclasses import dataclass` is fine — just switch `@_dataclass` to `@dataclass` in the new class.

- [ ] **Step 4: Run — passing.**

Run: `cd hub && uv run pytest tests/test_fs_writer.py -v`
Expected: 18 passing (14 from Task 2 + 4 from TestWriteFile).

- [ ] **Step 5: Commit.**

```bash
git add hub/services/fs_browser.py hub/tests/test_fs_writer.py
git commit -m "feat(m24): write_file coordinator with mtime guard + tar upload"
```

---

## Task 4: Mtime echo on read endpoint (TDD)

**Files:**

- Modify: `hub/routers/fs.py`
- Modify: `hub/tests/test_fs_browser.py` (or add a new test file if cleaner)

First verify the existing test coverage:

- [ ] **Step 1: Check the current read-endpoint test (if any).**

Run: `grep -rn "fs/read\|read_file" hub/tests/ --include="*.py" | head -10`

If there's an integration test for `/fs/read`, locate it and extend. If there isn't (likely — M17 shipped without a route test), create a minimal one.

- [ ] **Step 2: Add an assertion for the new `mtime_ns` field.**

Create `hub/tests/test_fs_read_endpoint.py`:

```python
"""M24 — verify the read endpoint echoes mtime_ns."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings


class _FakeRecord:
    def __init__(self) -> None:
        self.container_id = "deadbeef"


class _FakeRegistry:
    async def get(self, record_id: int) -> _FakeRecord:
        return _FakeRecord()


async def _client() -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = _FakeRegistry()
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_read_echoes_mtime_ns(monkeypatch) -> None:
    import docker

    container = MagicMock()
    # stat -c '%s|%Y.%N' → size|secs.nanos
    container.exec_run = MagicMock(
        side_effect=[
            (0, b"5|1700000000.123456789"),
            # file --mime-type
            (0, b"text/plain"),
            # cat
            (0, b"hello"),
        ],
    )
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container)
    monkeypatch.setattr(docker, "from_env", lambda: client)

    async with await _client() as c:
        resp = await c.get(
            "/api/containers/1/fs/read?path=/workspace/foo.txt",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["mtime_ns"] == 1_700_000_000_123_456_789
    assert body["size_bytes"] == 5
    assert body["content"] == "hello"
```

- [ ] **Step 3: Run — expect failure on mtime.**

Run: `cd hub && uv run pytest tests/test_fs_read_endpoint.py -v`
Expected: fails because the current route's stat is `'%s'` (size only), not `'%s|%Y.%N'`.

- [ ] **Step 4: Update `hub/routers/fs.py::read_file` to fetch mtime_ns alongside size.**

Find the existing `stat -c %s` call inside `read_file` (around line 173). Replace:

```python
    try:
        exit_code, output = container.exec_run(
            ["stat", "-c", "%s", "--", clean_path], tty=False, demux=False
        )
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"stat failed: {exc}") from exc
    if exit_code != 0:
        text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else ""
        raise HTTPException(400, text.strip() or f"stat exited with {exit_code}")
    try:
        size_bytes = int(output.decode("utf-8").strip())
    except (ValueError, AttributeError):
        raise HTTPException(502, "stat returned unparseable size")
```

with:

```python
    try:
        exit_code, output = container.exec_run(
            ["stat", "-c", "%s|%Y.%N", "--", clean_path], tty=False, demux=False
        )
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"stat failed: {exc}") from exc
    if exit_code != 0:
        text = output.decode("utf-8", errors="replace") if isinstance(output, bytes) else ""
        raise HTTPException(400, text.strip() or f"stat exited with {exit_code}")
    try:
        size_bytes, mtime_ns = parse_stat_size_mtime(output.decode("utf-8"))
    except (ValueError, AttributeError):
        raise HTTPException(502, "stat returned unparseable size/mtime")
```

Add `parse_stat_size_mtime` to the imports from `hub.services.fs_browser` at the top of the file.

Then find every `return FileContent(...)` inside `read_file` and add `mtime_ns=mtime_ns,` to the argument list. There are three return statements in `read_file`:

1. The oversized branch (`if size_bytes > cap`)
2. The text-decode success branch
3. The base64 fallback branch

All three must include `mtime_ns=mtime_ns`.

- [ ] **Step 5: Re-run — passing.**

Run: `cd hub && uv run pytest tests/test_fs_read_endpoint.py -v`
Expected: 1 passing.

- [ ] **Step 6: Run the full suite to catch any consumer that cared about the old shape.**

Run: `cd hub && uv run pytest -q`
Expected: all passing (previous total was 271; now 272 with the new read-endpoint test + whatever TestWriteFile/TestBuildWriteTar etc. add when Task 2 merges — that's 271 + Task 2's 14 + Task 3's 4 + Task 4's 1 = 290).

- [ ] **Step 7: Commit.**

```bash
git add hub/routers/fs.py hub/tests/test_fs_read_endpoint.py
git commit -m "feat(m24): read endpoint echoes mtime_ns for stale-write guard"
```

---

## Task 5: `PUT /fs/write` route + endpoint tests (TDD)

**Files:**

- Modify: `hub/routers/fs.py`
- Create: `hub/tests/test_fs_write_endpoint.py`

- [ ] **Step 1: Write failing route tests.**

Create `hub/tests/test_fs_write_endpoint.py`:

```python
"""Integration tests for PUT /api/containers/{id}/fs/write (M24)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings


class _FakeRecord:
    def __init__(self, container_id: str | None = "deadbeef") -> None:
        self.container_id = container_id


class _FakeRegistry:
    def __init__(self, record: _FakeRecord | None) -> None:
        self._record = record

    async def get(self, record_id: int) -> _FakeRecord:  # noqa: ARG002
        if self._record is None:
            raise KeyError(record_id)
        return self._record


async def _client(registry: _FakeRegistry) -> AsyncClient:
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    app.state.registry = registry
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _docker_with(monkeypatch, *, stat_responses: list, put_archive_result: bool = True) -> MagicMock:
    """Swap ``docker.from_env`` to return a client whose container
    returns the given stat responses in order and the given
    put_archive result."""
    import docker

    container = MagicMock()
    container.exec_run = MagicMock(side_effect=stat_responses)
    container.put_archive = MagicMock(return_value=put_archive_result)
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container)
    monkeypatch.setattr(docker, "from_env", lambda: client)
    return container


@pytest.mark.asyncio
async def test_write_happy_path_text(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[
            (0, b"100|1700000000.000000000"),
            (0, b"644|0|0"),
            (0, b"12|1700000100.000000000"),
        ],
    )
    registry = _FakeRegistry(_FakeRecord())
    body = {
        "path": "/w/foo.txt",
        "content": "hello world\n",
        "if_match_mtime_ns": 1_700_000_000_000_000_000,
    }
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json=body,
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    b = resp.json()
    assert b["path"] == "/w/foo.txt"
    assert b["mtime_ns"] == 1_700_000_100_000_000_000
    assert b["size_bytes"] == 12
    assert b["content"] == "hello world\n"


@pytest.mark.asyncio
async def test_write_base64_round_trip(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[
            (0, b"5|1700000000.000000000"),
            (0, b"644|0|0"),
            (0, b"5|1700000100.000000000"),
        ],
    )
    registry = _FakeRegistry(_FakeRecord())
    body = {
        "path": "/w/a.bin",
        "content_base64": "aGVsbG8=",
        "if_match_mtime_ns": 1_700_000_000_000_000_000,
    }
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json=body,
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json()["content_base64"] == "aGVsbG8="


@pytest.mark.asyncio
async def test_write_unauthorized() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "if_match_mtime_ns": 0,
            },
        )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_write_rejects_bad_path(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": ";rm -rf /",
                "content": "x",
                "if_match_mtime_ns": 0,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_write_rejects_both_content_fields(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "content_base64": "aGVsbG8=",
                "if_match_mtime_ns": 0,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_write_rejects_neither_content_field(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={"path": "/w/foo", "if_match_mtime_ns": 0},
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_write_404_on_missing_file(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[(1, b"stat: cannot stat '/nope': No such file or directory\n")],
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/nope",
                "content": "x",
                "if_match_mtime_ns": 0,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_write_409_on_mtime_mismatch(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[(0, b"100|1700000500.000000000")],
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "if_match_mtime_ns": 1_700_000_000_000_000_000,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 409
    body = resp.json()
    assert body["current_mtime_ns"] == 1_700_000_500_000_000_000


@pytest.mark.asyncio
async def test_write_413_on_oversize(monkeypatch) -> None:
    _docker_with(monkeypatch, stat_responses=[])
    registry = _FakeRegistry(_FakeRecord())
    body = {
        "path": "/w/big",
        "content": "x" * (5 * 1024 * 1024 + 1),
        "if_match_mtime_ns": 0,
    }
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json=body,
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 413


@pytest.mark.asyncio
async def test_write_502_on_put_archive_failure(monkeypatch) -> None:
    _docker_with(
        monkeypatch,
        stat_responses=[
            (0, b"100|1700000000.000000000"),
            (0, b"644|0|0"),
        ],
        put_archive_result=False,
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.put(
            "/api/containers/1/fs/write",
            json={
                "path": "/w/foo",
                "content": "x",
                "if_match_mtime_ns": 1_700_000_000_000_000_000,
            },
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 502
```

- [ ] **Step 2: Run — fails (route not defined).**

Run: `cd hub && uv run pytest tests/test_fs_write_endpoint.py -v`
Expected: 404 on every path.

- [ ] **Step 3: Add the route to `hub/routers/fs.py`.**

Add new imports to the existing `hub.services.fs_browser` import block:

```python
from hub.services.fs_browser import (
    # … existing symbols …
    FileNotFound,
    WriteConflict,
    WriteError,
    WriteTooLarge,
    decode_write_payload,
    write_file,
)
```

Also add `FileWriteRequest` to the `hub.models.schemas` import list at the top.

Append the route at the end of the file:

```python
@router.put("/{record_id}/fs/write", response_model=FileContent)
async def write_container_file(
    record_id: int,
    request: Request,
    body: FileWriteRequest,
) -> FileContent:
    """Overwrite ``body.path`` inside the container with the
    supplied content.

    Returns the fresh ``FileContent`` (content echoed back; new
    mtime_ns + size populated). See the M24 spec for the full
    contract: 404 on missing file, 409 on mtime mismatch, 413 on
    >5 MiB, 502 on put_archive / permission failures.
    """
    try:
        clean_path = validate_path(body.path)
    except InvalidFsPath as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        payload = decode_write_payload(
            content=body.content,
            content_base64=body.content_base64,
        )
    except InvalidFsPath as exc:
        raise HTTPException(400, str(exc)) from exc
    except WriteTooLarge as exc:
        raise HTTPException(413, str(exc)) from exc

    registry = request.app.state.registry
    container_id = await _lookup_container_id(registry, record_id)

    try:
        client = docker.from_env()
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        raise HTTPException(404, f"Docker container {container_id} not found")
    except docker.errors.DockerException as exc:
        raise HTTPException(502, f"Docker unavailable: {exc}") from exc

    try:
        result = write_file(
            container,
            path=clean_path,
            payload=payload,
            if_match_mtime_ns=body.if_match_mtime_ns,
        )
    except FileNotFound as exc:
        raise HTTPException(404, str(exc)) from exc
    except WriteConflict as exc:
        raise HTTPException(
            409,
            detail={"detail": str(exc), "current_mtime_ns": exc.current_mtime_ns},
        ) from exc
    except WriteError as exc:
        raise HTTPException(502, str(exc)) from exc
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"docker exec failed: {exc}") from exc

    # Build the FileContent echo. We already have the payload bytes
    # and the client-supplied mime is preserved from whatever the
    # prior read reported; since the route doesn't have that, we
    # re-sniff MIME.
    mime = _sniff_mime(container, clean_path)
    text_like = is_text_mime(mime)
    if text_like and body.content is not None:
        return FileContent(
            path=result.path,
            mime_type=mime,
            size_bytes=result.size,
            mtime_ns=result.mtime_ns,
            content=body.content,
        )
    if body.content_base64 is not None:
        return FileContent(
            path=result.path,
            mime_type=mime,
            size_bytes=result.size,
            mtime_ns=result.mtime_ns,
            content_base64=body.content_base64,
        )
    # Text payload that sniffs as binary — still echo as content.
    return FileContent(
        path=result.path,
        mime_type=mime,
        size_bytes=result.size,
        mtime_ns=result.mtime_ns,
        content=body.content,
    )
```

- [ ] **Step 4: Run — passing.**

Run: `cd hub && uv run pytest tests/test_fs_write_endpoint.py -v`
Expected: 10 passing. Note the `test_write_base64_round_trip` assertion expects the response to include `content_base64` — if \_sniff_mime returns `text/plain` for a base64 payload, the code path above would fall into the text branch. Ensure the `content_base64 is not None` check fires FIRST in the branch order (matches the code above).

- [ ] **Step 5: Run the full hub suite.**

Run: `cd hub && uv run pytest -q`
Expected: all green.

- [ ] **Step 6: Commit.**

```bash
git add hub/routers/fs.py hub/tests/test_fs_write_endpoint.py
git commit -m "feat(m24): PUT /api/containers/{id}/fs/write route with 409 mtime guard"
```

---

## Task 6: Dashboard — `writeContainerFile` API wrapper + types

**Files:**

- Modify: `dashboard/src/lib/types.ts`
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Update `FileContent` + add `FileWriteRequest` in `dashboard/src/lib/types.ts`.**

Find the existing `FileContent` interface (around the M18 block). Replace with:

```ts
export interface FileContent {
  path: string;
  mime_type: string;
  size_bytes: number;
  /** M24 — nanosecond-resolution mtime, echoed back on every read
   * so the client can send it as ``if_match_mtime_ns`` on PUT. 0
   * when the backend's stat failed. */
  mtime_ns: number;
  content?: string | null;
  content_base64?: string | null;
  truncated?: boolean;
  error?: string | null;
}

// M24 — write-back editing.

export interface FileWriteRequest {
  path: string;
  content?: string | null;
  content_base64?: string | null;
  if_match_mtime_ns: number;
}
```

- [ ] **Step 2: Add `writeContainerFile` to `dashboard/src/lib/api.ts`.**

At the top of the file, ensure `FileWriteRequest` is in the type import list alongside `FileContent`, `DirectoryListing`, etc.

Near the existing `readContainerFile` export, add:

```ts
export const writeContainerFile = (id: number, body: FileWriteRequest) =>
  request<FileContent>(`/containers/${id}/fs/write`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
```

Also check the `request` helper in the same file — it must accept a `RequestInit`-like options object with `method`, `headers`, `body`. If it currently only accepts GET, extend the signature. Keep backward compat: the second arg stays optional, the existing GET callers don't change.

(If `request`'s signature needs extending: update it to `request<T>(path: string, init?: RequestInit): Promise<T>`. Most likely it already supports this — verify by reading the file.)

- [ ] **Step 3: Typecheck.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 4: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts
git commit -m "feat(m24): writeContainerFile wrapper + FileWriteRequest types"
```

---

## Task 7: CodeMirror 6 dependencies

**Files:**

- Modify: `dashboard/package.json` + `dashboard/package-lock.json`

- [ ] **Step 1: Install the CodeMirror package set.**

Run:

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npm install \
  codemirror@^6.0.1 \
  @codemirror/state@^6.4.1 \
  @codemirror/view@^6.26.3 \
  @codemirror/commands@^6.5.0 \
  @codemirror/language@^6.10.1 \
  @codemirror/search@^6.5.6 \
  @codemirror/autocomplete@^6.16.0 \
  @codemirror/lang-javascript@^6.2.2 \
  @codemirror/lang-python@^6.1.5 \
  @codemirror/lang-markdown@^6.2.5 \
  @codemirror/lang-json@^6.0.1 \
  @codemirror/lang-css@^6.2.1 \
  @codemirror/lang-html@^6.4.9 \
  @codemirror/theme-one-dark@^6.1.2
```

Expected: no peer-dep warnings (CodeMirror has clean peers).

- [ ] **Step 2: Typecheck.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/package.json dashboard/package-lock.json
git commit -m "feat(m24): add CodeMirror 6 + one-dark theme + language packs"
```

---

## Task 8: `<CodeEditor>` component (TDD)

**Files:**

- Create: `dashboard/src/components/CodeEditor.tsx`
- Create: `dashboard/src/components/__tests__/CodeEditor.test.tsx`

- [ ] **Step 1: Write failing tests.**

Create `dashboard/src/components/__tests__/CodeEditor.test.tsx`:

```tsx
/** CodeEditor tests (M24) — mount, controlled value, onChange, readOnly.
 *
 * jsdom lacks layout APIs CodeMirror touches; we stub the ones we
 * need in test-setup.ts (Task 8's sibling; ``document.createRange``
 * and ``Element.prototype.getClientRects``). Without those stubs the
 * ``EditorView`` throws on mount.
 */

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeEditor, languageForPath } from "../CodeEditor";

afterEach(() => vi.restoreAllMocks());

describe("languageForPath", () => {
  it.each([
    ["src/App.tsx", "typescript"],
    ["foo.py", "python"],
    ["package.json", "json"],
    ["README.md", "markdown"],
    ["style.css", "css"],
    ["index.html", "html"],
    ["no-ext", "plaintext"],
    ["WEIRD.CaSe.PY", "python"],
  ])("%s → %s", (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });
});

describe("CodeEditor", () => {
  it("mounts with the initial value", () => {
    const { container } = render(
      <CodeEditor value="hello world" onChange={() => {}} language="plaintext" />,
    );
    // CodeMirror renders a ``.cm-editor`` wrapper + a ``.cm-content`` that
    // contains the document text.
    const content = container.querySelector(".cm-content");
    expect(content?.textContent).toContain("hello world");
  });

  it("fires onChange when the user types", async () => {
    const onChange = vi.fn();
    const { container } = render(<CodeEditor value="" onChange={onChange} language="plaintext" />);
    const content = container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    content!.focus();
    await userEvent.type(content!, "abc");
    // CodeMirror batches transactions; by the end of ``type`` we
    // should have seen at least one call whose argument contains
    // the typed characters.
    expect(onChange).toHaveBeenCalled();
    const allArgs = onChange.mock.calls.map((c) => c[0]).join("");
    expect(allArgs).toContain("abc");
  });

  it("readOnly prevents edits", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor value="locked" onChange={onChange} language="plaintext" readOnly />,
    );
    const content = container.querySelector<HTMLElement>(".cm-content");
    content!.focus();
    await userEvent.type(content!, "xxx");
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Update test-setup for CodeMirror's DOM needs.**

Open `dashboard/src/test-setup.ts`. Append:

```ts
// CodeMirror calls ``document.createRange`` and measures ranges
// with ``getClientRects``. jsdom stubs both as undefined / empty,
// which causes ``EditorView`` to throw on mount. Keep the stubs
// minimal — CodeMirror's measure loop will render the editor but
// the tests only assert on DOM text / click events, not on pixel
// coordinates.
if (typeof document.createRange === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).createRange = () => ({
    setStart: () => {},
    setEnd: () => {},
    commonAncestorContainer: document.body,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getClientRects: () => ({ item: () => null, length: 0, [Symbol.iterator]: function* () {} }),
  });
}
if (typeof Element.prototype.getClientRects === "undefined") {
  Element.prototype.getClientRects = function (): DOMRectList {
    return {
      item: () => null,
      length: 0,
      [Symbol.iterator]: function* () {},
    } as unknown as DOMRectList;
  };
}
```

- [ ] **Step 3: Run — fails (CodeEditor not defined).**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/CodeEditor.test.tsx
```

Expected: import error.

- [ ] **Step 4: Implement `dashboard/src/components/CodeEditor.tsx`.**

```tsx
/** CodeMirror 6 wrapper with language detection + dark theme (M24).
 *
 * Bridges CodeMirror's imperative ``EditorView`` to React's
 * declarative ``value`` / ``onChange`` model:
 *
 * - Initial mount creates an EditorView inside a div ref. The
 *   ``updateListener`` fires the parent's ``onChange`` when the doc
 *   changes AND the change didn't originate from our own external-
 *   value sync (guarded by a ref that holds the last-dispatched
 *   string).
 * - Prop ``value`` changes that DIFFER from the editor's current doc
 *   trigger a single transaction replacing the whole doc — the
 *   parent "reset draft" path when the user reloads from the conflict
 *   banner.
 * - ``readOnly`` toggles an editor config compartment so we don't
 *   need to recreate the view.
 * - On unmount we ``editor.destroy()``.
 *
 * Extensions: basicSetup (line numbers + history + fold + bracket
 * matching), the one-dark theme, and the language extension picked
 * by ``languageForPath()`` at the call site.
 */

import { autocompletion, closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

export type CodeEditorLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "json"
  | "markdown"
  | "css"
  | "html"
  | "plaintext";

export interface CodeEditorProps {
  value: string;
  onChange: (next: string) => void;
  language: CodeEditorLanguage;
  readOnly?: boolean;
  className?: string;
}

const LANG_BY_EXT: Record<string, CodeEditorLanguage> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
};

export function languageForPath(path: string): CodeEditorLanguage {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

function languageExtension(lang: CodeEditorLanguage): Extension {
  switch (lang) {
    case "javascript":
      return javascript();
    case "typescript":
      return javascript({ typescript: true });
    case "python":
      return python();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "css":
      return css();
    case "html":
      return html();
    default:
      return [];
  }
}

function basicSetup(): Extension {
  // Hand-rolled ``basicSetup`` equivalent so we control the exact
  // extension set (the upstream ``basicSetup`` import pulls more
  // than we need and bloats the bundle).
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...lintKeymap]),
  ];
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompRef = useRef(new Compartment());
  const langCompRef = useRef(new Compartment());
  const lastDispatchedRef = useRef(value);

  // Mount once on first render. We intentionally do NOT include
  // ``value`` in the deps — prop changes are synced via the second
  // effect below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup(),
        langCompRef.current.of(languageExtension(language)),
        readOnlyCompRef.current.of(EditorState.readOnly.of(readOnly)),
        oneDark,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          if (next === lastDispatchedRef.current) return;
          lastDispatchedRef.current = next;
          onChange(next);
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value → editor when the parent resets the draft
  // (e.g. the "Reload" button on the conflict banner).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    lastDispatchedRef.current = value;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  // Toggle language / readOnly without recreating the view.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: langCompRef.current.reconfigure(languageExtension(language)),
    });
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly]);

  return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
```

Note the import block pulls a few symbols (`@codemirror/lint`, etc.) that aren't in the Task 7 install list. Add `@codemirror/lint` to package.json:

```bash
cd dashboard && npm install @codemirror/lint@^6.5.0 && cd ..
```

- [ ] **Step 5: Run — passing.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/CodeEditor.test.tsx
```

Expected: 3 CodeEditor tests passing + 8 `languageForPath` cases = 11 total.

- [ ] **Step 6: Typecheck.**

```bash
npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/CodeEditor.tsx \
        dashboard/src/components/__tests__/CodeEditor.test.tsx \
        dashboard/src/test-setup.ts \
        dashboard/package.json \
        dashboard/package-lock.json
git commit -m "feat(m24): CodeEditor wraps CodeMirror 6 with lang detection + dark theme"
```

---

## Task 9: ErrorBoundary `fallback` prop extension

**Files:**

- Modify: `dashboard/src/components/ErrorBoundary.tsx`

- [ ] **Step 1: Add the optional prop + short-circuit render.**

Replace the `Props` interface and the `render` method in `dashboard/src/components/ErrorBoundary.tsx`.

Find the existing:

```tsx
interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback UI. Defaults to "the editor". */
  label?: string;
  /** Called with every caught error; useful for tests + logging hooks. */
  onError?: (error: Error, info: ErrorInfo) => void;
}
```

Replace with:

```tsx
interface Props {
  children: ReactNode;
  /** Optional label shown in the fallback UI. Defaults to "the editor". */
  label?: string;
  /** Called with every caught error; useful for tests + logging hooks. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** M24 — when set, replaces the default "Try again" card with the
   * supplied node. Consumers that want to preserve operation despite
   * a child crash (e.g., the FileViewer's textarea fallback when
   * CodeMirror fails to load) opt in via this prop. */
  fallback?: ReactNode;
}
```

Find the existing render method. Replace the error branch:

```tsx
  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const label = this.props.label ?? "the editor";
    return (
      <div
        role="alert"
        ...
```

with:

```tsx
  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    // M24 — fall back to the consumer-supplied node if present. No
    // label / reset button in this path; the consumer owns recovery.
    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    const label = this.props.label ?? "the editor";
    return (
      <div
        role="alert"
        ...
```

(Leave everything after `role="alert"` untouched — the existing default-card JSX is preserved as the no-fallback branch.)

- [ ] **Step 2: Typecheck + lint.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx tsc --noEmit && npm run lint
```

Expected: 0 errors.

- [ ] **Step 3: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/ErrorBoundary.tsx
git commit -m "feat(m24): ErrorBoundary accepts a fallback node prop"
```

---

## Task 10: FileViewer edit mode (TDD)

**Files:**

- Modify: `dashboard/src/components/FileViewer.tsx`
- Create: `dashboard/src/components/__tests__/FileViewer.test.tsx`

- [ ] **Step 1: Write failing tests.**

Create `dashboard/src/components/__tests__/FileViewer.test.tsx`:

```tsx
/** FileViewer edit-mode tests (M24).
 *
 * Covers: Edit button visibility rules, edit-mode flip, Save calls
 * writeContainerFile with the echoed mtime, 409 surfaces the
 * conflict banner, Cancel with dirty draft prompts, and the
 * ErrorBoundary fallback when the CodeEditor throws.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileViewer } from "../FileViewer";
import { ToastProvider } from "../../hooks/useToasts";

const mockRead = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
      path: string,
    ) => Promise<{
      path: string;
      mime_type: string;
      size_bytes: number;
      mtime_ns: number;
      content: string | null;
      content_base64?: string | null;
      truncated: boolean;
    }>
  >(),
);
const mockWrite = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
      body: {
        path: string;
        content?: string | null;
        content_base64?: string | null;
        if_match_mtime_ns: number;
      },
    ) => Promise<unknown>
  >(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    readContainerFile: mockRead,
    writeContainerFile: mockWrite,
  };
});

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  mockRead.mockReset();
  mockWrite.mockReset();
  qc = new QueryClient({
    defaultOptions: { queries: { retry: false, throwOnError: false } },
  });
});
afterEach(() => {
  qc.clear();
  vi.restoreAllMocks();
});

function textFile(content: string, mtime = 1_700_000_000_000_000_000) {
  return {
    path: "/w/foo.md",
    mime_type: "text/markdown",
    size_bytes: content.length,
    mtime_ns: mtime,
    content,
    truncated: false,
  };
}

describe("FileViewer — M24 edit mode", () => {
  it("renders an Edit button for text files", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    render(<FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />, { wrapper });
    const btn = await screen.findByRole("button", { name: /edit/i });
    expect(btn).toBeInTheDocument();
  });

  it("does not render an Edit button for truncated files", async () => {
    mockRead.mockResolvedValue({ ...textFile(""), truncated: true, content: null });
    render(<FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />, { wrapper });
    await screen.findByText(/too large to preview/i);
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it("clicking Edit swaps in an editor seeded with the content", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    const { container } = render(
      <FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />,
      { wrapper },
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const cm = container.querySelector(".cm-content");
    expect(cm?.textContent).toContain("hello");
  });

  it("Save posts the draft with if_match_mtime_ns from the read", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    mockWrite.mockResolvedValue(textFile("hello-edited", 1_700_000_100_000_000_000));
    const { container } = render(
      <FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />,
      { wrapper },
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const cm = container.querySelector<HTMLElement>(".cm-content");
    cm!.focus();
    await userEvent.type(cm!, "-edited");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(mockWrite).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        path: "/w/foo.md",
        if_match_mtime_ns: 1_700_000_000_000_000_000,
      }),
    );
  });

  it("409 surfaces the conflict banner", async () => {
    mockRead.mockResolvedValue(textFile("hello"));
    const apiErr = Object.assign(new Error("409: File changed"), { status: 409 });
    mockWrite.mockRejectedValue(apiErr);
    const { container } = render(
      <FileViewer containerId={1} path="/w/foo.md" onClose={() => {}} />,
      { wrapper },
    );
    await userEvent.click(await screen.findByRole("button", { name: /edit/i }));
    const cm = container.querySelector<HTMLElement>(".cm-content");
    cm!.focus();
    await userEvent.type(cm!, "x");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^reload$/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — fails.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/FileViewer.test.tsx
```

Expected: assertion failures (Edit button absent, etc.) — the current FileViewer has no edit mode.

- [ ] **Step 3: Rewrite `dashboard/src/components/FileViewer.tsx` for edit mode.**

Replace the file with:

```tsx
/** File viewer with write-back editing (M18 + M24).
 *
 * Read mode: dispatches by MIME ({text, image, notebook, oversize}).
 * Edit mode: swaps the ``<pre>`` for a ``<CodeEditor>`` (CodeMirror
 * 6) with a textarea ErrorBoundary fallback. Save posts the current
 * draft with ``if_match_mtime_ns`` = last-read mtime; 409 responses
 * surface a yellow conflict banner.
 */

import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Download, FileText, Image as ImageIcon, Notebook, Pencil, Save, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { containerFileDownloadUrl, readContainerFile, writeContainerFile } from "../lib/api";
import type { FileContent } from "../lib/types";
import { useToasts } from "../hooks/useToasts";
import { CodeEditor, languageForPath } from "./CodeEditor";
import { ErrorBoundary } from "./ErrorBoundary";
import { NotebookViewer } from "./NotebookViewer";

interface Props {
  containerId: number;
  path: string;
  onClose: () => void;
}

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "application/x-sh",
  "application/x-yaml",
  "application/toml",
  "application/x-ipynb+json",
];

function isTextMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return TEXT_MIME_PREFIXES.some((p) => m.startsWith(p));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function FileViewer({ containerId, path, onClose }: Props) {
  const queryClient = useQueryClient();
  const { toast } = useToasts();
  const { data, error, isLoading } = useQuery<FileContent>({
    queryKey: ["fs:read", containerId, path],
    queryFn: () => readContainerFile(containerId, path),
    staleTime: 30_000,
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const isNotebook = path.toLowerCase().endsWith(".ipynb");
  const canEdit =
    data !== undefined &&
    data.content !== null &&
    data.content !== undefined &&
    !data.truncated &&
    !isNotebook &&
    isTextMime(data.mime_type);

  // Seed draft whenever we enter edit mode or swap files.
  useEffect(() => {
    if (!editing) return;
    if (!data) return;
    setDraft(data.content ?? "");
    setBaseMtime(data.mtime_ns ?? 0);
    setConflict(false);
  }, [editing, data]);

  const dirty = editing && data !== undefined && draft !== (data.content ?? "");

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [dirty, onClose]);

  const handleCancel = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setEditing(false);
    setDraft("");
    setConflict(false);
  }, [dirty]);

  const handleSave = useCallback(async () => {
    if (!data || baseMtime === null) return;
    setSaving(true);
    try {
      const updated = (await writeContainerFile(containerId, {
        path,
        content: draft,
        if_match_mtime_ns: baseMtime,
      })) as FileContent;
      toast("success", "Saved", `${humanSize(updated.size_bytes)} written to ${path}`);
      queryClient.setQueryData<FileContent>(["fs:read", containerId, path], updated);
      setBaseMtime(updated.mtime_ns);
      setConflict(false);
      setEditing(false);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) {
        setConflict(true);
      } else {
        toast("error", "Save failed", err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }, [containerId, path, draft, baseMtime, data, toast, queryClient]);

  const handleReload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["fs:read", containerId, path] });
    // The refetch lands asynchronously; rely on the ``useEffect``
    // above keying on ``data`` to reseed once the new content arrives.
    setConflict(false);
  }, [queryClient, containerId, path]);

  const handleSaveAnyway = useCallback(async () => {
    // Re-read to obtain the current mtime; write with that echo so
    // the hub accepts the write. Draft is preserved verbatim.
    const latest = await readContainerFile(containerId, path);
    if (!latest.mtime_ns) {
      toast("error", "Save failed", "Could not re-read file for baseline");
      return;
    }
    setBaseMtime(latest.mtime_ns);
    setSaving(true);
    try {
      const updated = (await writeContainerFile(containerId, {
        path,
        content: draft,
        if_match_mtime_ns: latest.mtime_ns,
      })) as FileContent;
      toast("success", "Saved", `${humanSize(updated.size_bytes)} written to ${path}`);
      queryClient.setQueryData<FileContent>(["fs:read", containerId, path], updated);
      setBaseMtime(updated.mtime_ns);
      setConflict(false);
      setEditing(false);
    } catch (err) {
      toast("error", "Save failed", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [containerId, path, draft, toast, queryClient]);

  const downloadUrl = containerFileDownloadUrl(containerId, path);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <header className="flex items-center gap-2 border-b border-[#2b2b2b] px-3 py-1.5 text-[11px]">
        {isNotebook ? (
          <Notebook size={11} className="text-orange-400" />
        ) : data?.mime_type.startsWith("image/") ? (
          <ImageIcon size={11} className="text-purple-400" />
        ) : (
          <FileText size={11} className="text-blue-400" />
        )}
        <span className="truncate font-mono text-[#e7e7e7]" title={path}>
          {path}
        </span>
        {data && (
          <span className="text-[10px] text-[#858585]">
            {data.mime_type} · {humanSize(data.size_bytes)}
          </span>
        )}
        {editing && dirty && (
          <span className="text-[10px] text-yellow-400" aria-live="polite">
            Modified
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!editing && canEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
              title="Edit"
            >
              <Pencil size={11} />
              Edit
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1 rounded bg-[#0078d4] px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-[#1188e0] disabled:opacity-60"
                title="Save"
              >
                <Save size={11} />
                {saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={saving}
                className="rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
                title="Cancel"
              >
                Cancel
              </button>
            </>
          )}
          <a
            href={downloadUrl}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
            title="Download"
          >
            <Download size={11} />
            Download
          </a>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-0.5 text-[#858585] hover:bg-[#232323] hover:text-[#c0c0c0]"
            aria-label="Close file viewer"
            title="Close"
          >
            <X size={11} />
          </button>
        </div>
      </header>

      {editing && conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-[#3a3a0a] bg-[#2a2410] px-3 py-1.5 text-[11px] text-yellow-300"
        >
          <span>File changed on disk.</span>
          <button
            type="button"
            onClick={handleReload}
            className="rounded border border-yellow-700 px-1.5 py-0.5 text-[10px] hover:bg-yellow-900/40"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={handleSaveAnyway}
            className="rounded border border-yellow-700 px-1.5 py-0.5 text-[10px] hover:bg-yellow-900/40"
          >
            Save anyway
          </button>
          <span className="text-[10px] text-yellow-400/80">
            Reload fetches the latest; Save anyway re-reads the on-disk baseline and writes your
            draft.
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <p className="p-4 text-xs text-[#858585]">Loading…</p>}
        {error && (
          <p className="p-4 text-xs text-red-400">
            Failed to read: {error instanceof Error ? error.message : String(error)}
          </p>
        )}
        {data && editing && (
          <ErrorBoundary
            label={`the editor for ${path}`}
            onError={() => toast("warning", "Editor failed", "Using plain-text fallback.")}
            fallback={
              <textarea
                className="m-0 block h-full min-h-full w-full resize-none border-0 bg-[#1e1e1e] px-4 py-3 font-mono text-[12px] leading-relaxed text-[#cccccc] outline-none"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                wrap="off"
              />
            }
          >
            <CodeEditor value={draft} onChange={setDraft} language={languageForPath(path)} />
          </ErrorBoundary>
        )}
        {data && !editing && (
          <FileBody data={data} downloadUrl={downloadUrl} isNotebook={isNotebook} />
        )}
      </div>
    </div>
  );
}

function FileBody({
  data,
  downloadUrl,
  isNotebook,
}: {
  data: FileContent;
  downloadUrl: string;
  isNotebook: boolean;
}) {
  if (isNotebook && data.content !== null && data.content !== undefined) {
    return <NotebookViewer source={data.content} />;
  }
  if (data.truncated) {
    return (
      <div className="p-4 text-xs text-[#858585]">
        <p>
          File is {(data.size_bytes / (1024 * 1024)).toFixed(2)} MiB — too large to preview inline.
        </p>
        <a
          href={downloadUrl}
          className="mt-2 inline-flex items-center gap-1 rounded bg-[#0078d4] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#1188e0]"
        >
          <Download size={11} /> Download
        </a>
      </div>
    );
  }
  if (data.mime_type.startsWith("image/") && data.content_base64) {
    return (
      <div className="flex min-h-full items-center justify-center p-4">
        <img
          src={`data:${data.mime_type};base64,${data.content_base64}`}
          alt={data.path}
          className="max-h-full max-w-full"
        />
      </div>
    );
  }
  if (data.content !== null && data.content !== undefined) {
    return (
      <pre className="m-0 min-h-full px-4 py-3 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-[#cccccc]">
        {data.content}
      </pre>
    );
  }
  return (
    <div className="p-4 text-xs text-[#858585]">
      No inline preview available for this MIME type.
      <a
        href={downloadUrl}
        className="ml-2 inline-flex items-center gap-1 rounded bg-[#0078d4] px-2 py-1 text-[11px] font-medium text-white hover:bg-[#1188e0]"
      >
        <Download size={11} /> Download
      </a>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect passing.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/__tests__/FileViewer.test.tsx
```

Expected: 5 passing.

- [ ] **Step 5: Typecheck + lint.**

```bash
npx tsc --noEmit && npm run lint
```

Expected: 0 errors.

- [ ] **Step 6: Full vitest.**

```bash
npx vitest run
```

Expected: all prior tests still pass.

- [ ] **Step 7: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/FileViewer.tsx dashboard/src/components/__tests__/FileViewer.test.tsx
git commit -m "feat(m24): FileViewer edit mode — CodeEditor + conflict banner + save handler"
```

---

## Task 11: Playwright — file-write end-to-end

**Files:**

- Create: `dashboard/tests/e2e/file-write.spec.ts`

- [ ] **Step 1: Write the spec.**

Create `dashboard/tests/e2e/file-write.spec.ts`:

```ts
/** M24 — file write-back round trip.
 *
 * Stubs ``/fs/read`` and ``/fs/write`` to avoid spinning up a real
 * container. Asserts that Edit → type → Save sends the correct PUT
 * body and that a 409 response surfaces the conflict banner.
 */

import { expect, test, type Route } from "@playwright/test";

const TOKEN = "file-write-token";

test.beforeEach(async ({ context }) => {
  await context.addInitScript(
    ([t, openTab, activeTab]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", openTab);
        window.localStorage.setItem("hive:layout:activeTab", activeTab);
      } catch {
        // ignore
      }
    },
    [TOKEN, "[7]", "7"],
  );

  const mockJson = (data: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(data),
  });

  await context.route("**/api/containers", (route) =>
    route.fulfill(
      mockJson([
        {
          id: 7,
          workspace_folder: "/w",
          project_type: "base",
          project_name: "demo",
          project_description: "",
          git_repo_url: null,
          container_id: "dead",
          container_status: "running",
          agent_status: "idle",
          agent_port: 0,
          has_gpu: false,
          has_claude_cli: false,
          claude_cli_checked_at: null,
          created_at: "2026-04-19",
          updated_at: "2026-04-19",
          agent_expected: false,
        },
      ]),
    ),
  );
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/gitops/prs**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (route) => route.fulfill(mockJson([])));
  await context.route("**/api/problems**", (route) => route.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (route) =>
    route.fulfill(
      mockJson({
        values: { log_level: "INFO", discover_roots: [], metrics_enabled: true },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (route) => route.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/containers/7/sessions", (route) =>
    route.fulfill(mockJson({ sessions: [] })),
  );
  await context.route("**/ws**", (route) => route.fulfill({ status: 404 }));
  await context.route("**/api/containers/7/fs/walk*", (route) =>
    route.fulfill(
      mockJson({
        root: "/w",
        entries: [
          { name: "/w/README.md", kind: "file", size: 11, mode: "", mtime: "", target: null },
        ],
        truncated: false,
        elapsed_ms: 1,
      }),
    ),
  );
});

async function openFileFromPalette(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/type a command/i).fill("file:README");
  await page.getByText("/w/README.md").click();
  await expect(page.getByRole("button", { name: /close file viewer/i })).toBeVisible();
}

test("Edit → type → Save posts the draft + echoes new mtime", async ({ context, page }) => {
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "/w/README.md",
        mime_type: "text/markdown",
        size_bytes: 5,
        mtime_ns: 1_700_000_000_000_000_000,
        content: "hello",
        truncated: false,
      }),
    }),
  );

  const writeCalls: unknown[] = [];
  await context.route("**/api/containers/7/fs/write", async (route: Route) => {
    writeCalls.push(JSON.parse(route.request().postData() ?? "null"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "/w/README.md",
        mime_type: "text/markdown",
        size_bytes: 8,
        mtime_ns: 1_700_000_100_000_000_000,
        content: "hello!!!",
        truncated: false,
      }),
    });
  });

  await openFileFromPalette(page);
  await page.getByRole("button", { name: /^edit$/i }).click();

  // Focus the CodeMirror content and type three "!" characters.
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.type("!!!");

  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/saved/i)).toBeVisible();
  expect(writeCalls).toHaveLength(1);
  expect((writeCalls[0] as { path: string }).path).toBe("/w/README.md");
  expect((writeCalls[0] as { if_match_mtime_ns: number }).if_match_mtime_ns).toBe(
    1_700_000_000_000_000_000,
  );
});

test("409 response shows the conflict banner with Reload + Save anyway", async ({
  context,
  page,
}) => {
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        path: "/w/README.md",
        mime_type: "text/markdown",
        size_bytes: 5,
        mtime_ns: 1_700_000_000_000_000_000,
        content: "hello",
        truncated: false,
      }),
    }),
  );
  await context.route("**/api/containers/7/fs/write", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        detail: "File changed on disk",
        current_mtime_ns: 1_700_000_500_000_000_000,
      }),
    }),
  );

  await openFileFromPalette(page);
  await page.getByRole("button", { name: /^edit$/i }).click();
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.type("X");
  await page.getByRole("button", { name: /^save$/i }).click();
  await expect(page.getByText(/changed on disk/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /^reload$/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /^save anyway$/i })).toBeVisible();
});
```

- [ ] **Step 2: Run the spec.**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test --reporter=line tests/e2e/file-write.spec.ts
```

Expected: 2 passing.

- [ ] **Step 3: Full Playwright suite.**

```bash
npx playwright test --reporter=line
```

Expected: previous 12 + 2 new = 14 passing.

- [ ] **Step 4: Commit.**

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/file-write.spec.ts
git commit -m "test(m24): Playwright — file write-back + 409 conflict banner"
```

---

## Task 12: Prettier sweep + full verification

**Files:** whatever prettier touches.

- [ ] **Step 1: Prettier-write dashboard (CI drift workaround — memory entry).**

```bash
export PATH=/home/gnava/.vscode-server/bin/560a9dba96f961efea7b1612916f89e5d5d4d679:$PATH
cd /home/gnava/repos/honeycomb/dashboard
npx prettier --write .
```

- [ ] **Step 2: Typecheck + lint + full vitest.**

```bash
npx tsc --noEmit && npm run lint && npx vitest run
```

Expected: 0 errors; all tests green.

- [ ] **Step 3: Full Playwright suite.**

```bash
npx playwright test --reporter=line
```

Expected: all green.

- [ ] **Step 4: Full hub pytest.**

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest -q
```

Expected: all green.

- [ ] **Step 5: Commit prettier changes (if any).**

```bash
cd /home/gnava/repos/honeycomb
git status
# If prettier modified anything:
git add -u
git commit -m "style(m24): prettier sweep before push" || true
```

---

## Task 13: Ship — merge, tag, push, CI watch

- [ ] **Step 1: Verify branch state.**

```bash
git log --oneline main..HEAD
```

Expected: 12–13 M24 commits (1 spec + 1 plan already exist + 11–12 feat/test/style).

- [ ] **Step 2: Merge to main with --no-ff.**

```bash
git checkout main && git pull --ff-only
git merge --no-ff m24-write-back-editing -m "$(cat <<'EOF'
Merge M24: write-back editing with CodeMirror 6 (textarea fallback)

  * PUT /api/containers/{id}/fs/write lands file bytes via
    container.put_archive(). Overwrite-only; 409 on mtime
    mismatch, 413 on >5 MiB, 502 on permission / RO mount.
  * FileContent gains mtime_ns; clients echo it as
    if_match_mtime_ns on write.
  * FileViewer grows Edit/Save/Cancel + CodeMirror 6 editor
    with one-dark theme and per-extension language detection.
    ErrorBoundary fallback to <textarea> keeps writes working
    if CodeMirror fails to load.
  * Yellow conflict banner on 409 offers Reload (fetch latest)
    or Save anyway (re-read for baseline then write).
  * Absorbs what the earlier roadmap split as M27 (CodeMirror
    integration) — the editor ships alongside the save path
    rather than in two rounds.

Full vitest + Playwright + hub pytest pass locally; prettier
sweep applied before push.
EOF
)"
```

- [ ] **Step 3: Tag.**

```bash
git tag -a v0.24-write-back -m "M24 — write-back editing with CodeMirror 6"
```

- [ ] **Step 4: Push with tags.**

```bash
git push origin main --follow-tags
```

- [ ] **Step 5: Delete the merged branch.**

```bash
git branch -d m24-write-back-editing
```

- [ ] **Step 6: Watch CI.**

```bash
export GH_TOKEN=$(grep -E '^GITHUB_TOKEN=' .env | cut -d= -f2-)
sleep 5
gh run list --branch main --limit 2
# find the in-progress run id
gh run watch <RUN_ID> --exit-status --interval 15
```

Expected: all 7 CI jobs green.

- [ ] **Step 7: Report result to user** with tag + CI summary.

---

## Notes / pitfalls for the implementing engineer

- **`put_archive` PAX vs USTAR.** Docker-py supports both; PAX is the default in modern Python. We pass `tarfile.PAX_FORMAT` explicitly to future-proof against long filenames + non-ASCII paths. Older docker daemons (< 18.09) may reject PAX — if that surfaces, switch to `tarfile.GNU_FORMAT`. Unlikely to be a real problem in 2026.
- **`stat` output resolution.** `%N` is GNU-only. BusyBox (Alpine without coreutils) prints a literal `N` in the output. The mtime parser would raise `ValueError`; router → 502. If a user reports a false 502 on Alpine, we add an `ls --time-style=full-iso` fallback in a follow-up. Keeping the M24 scope tight on GNU coreutils is acceptable for the default containers.
- **Base64 response echo.** The route's echo branch checks `body.content_base64 is not None` FIRST so a base64 payload round-trips as base64 even when the MIME sniff calls it text-like. Text payloads use the `content` branch.
- **CodeMirror + jsdom.** jsdom lacks layout APIs — the `test-setup.ts` stubs for `document.createRange` + `Element.prototype.getClientRects` were required in M23 for cmdk; same shims cover CodeMirror. If a CodeMirror-internal assertion fires in tests about a method we didn't stub, the usual fix is to add it to `test-setup.ts` (keep it minimal — CodeMirror's behaviour under jsdom is "render, don't measure accurately").
- **`useCallback` dependency arrays.** Several of the new FileViewer handlers have dependency arrays containing `data`, which React's exhaustive-deps ESLint rule is picky about. If lint complains, suppress on a line-by-line basis with `// eslint-disable-next-line react-hooks/exhaustive-deps` — the handlers close over the current `data` and we want them to pick up fresh reads without recreating constantly.
- **ApiError class.** The existing `request` helper in `dashboard/src/lib/api.ts` likely throws an `Error` with a `status` property attached (not a custom `ApiError` class). If so, the `err.status` check in `handleSave` works. If there IS a class and its name isn't `ApiError`, update the spec note inline — the important thing is that 409 responses surface with `status === 409` on the caught error.
- **Prettier sweep.** Per the memory entry, CI's `npx prettier --check .` is stricter than the pre-commit hook. Running `npx prettier --write .` in `dashboard/` before push is the reliable workaround. Task 12 does this unconditionally.

## Self-review summary

**Spec coverage.**

| Spec section                            | Implementing task(s)              |
| --------------------------------------- | --------------------------------- |
| §1 Architecture (overview)              | Tasks 1–11 collectively           |
| §2 Backend route + write_file           | Tasks 1, 2, 3, 4, 5               |
| §2 Exceptions + router mapping          | Tasks 2, 3, 5                     |
| §2 Read endpoint mtime echo             | Task 4                            |
| §3 CodeEditor component                 | Tasks 7, 8                        |
| §4 FileViewer edit mode                 | Tasks 9, 10                       |
| §4 Conflict banner + Reload/Save anyway | Task 10                           |
| §4 Dirty-state confirm                  | Task 10                           |
| §4 Edit button visibility rules         | Task 10                           |
| §4 Textarea fallback via ErrorBoundary  | Tasks 9, 10                       |
| §5 Error handling                       | Tasks 3, 5, 10                    |
| §6 Testing                              | Tasks 2, 3, 4, 5, 8, 10, 11       |
| §7 Manual smoke                         | Documented in spec; not automated |

**Placeholder scan.** No TBD/TODO. Every step has concrete code or a concrete command.

**Type consistency.** `FileContent.mtime_ns` is `int` (Python) / `number` (TS); `FileWriteRequest.if_match_mtime_ns` matches. `WriteConflict` exposes `current_mtime_ns`; route body uses the same field. Exception names used in Tasks 3 + 5 match definitions in Task 2. `CodeEditorLanguage` is consistent across the component, its props, and `languageForPath`.
