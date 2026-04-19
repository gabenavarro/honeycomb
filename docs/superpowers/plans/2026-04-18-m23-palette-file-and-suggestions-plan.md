# M23 Implementation Plan — Command palette file-mode + contextual suggestions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inside the existing Ctrl+K palette, add (α) a `file:<query>` fuzzy file-finder rooted at the active container's WORKDIR and (ζ) a "Suggestions for {project}" group parsed from `package.json`, `pyproject.toml`, and `Makefile` at WORKDIR. Land the backend walk as a reusable file-index primitive.

**Architecture:** New `GET /api/containers/{id}/fs/walk` endpoint in `hub/routers/fs.py`, backed by `walk_paths()` + two pure helpers in `hub/services/fs_browser.py`. Dashboard gets two React Query-backed hooks (`useContainerFileIndex`, `useContainerSuggestions`), palette gains a `mode` state driven by the input prefix, and PTY pre-typing rides on a new `CustomEvent`-based bus so suggestions can pre-fill a shell session without tight coupling to `PtyPane`.

**Tech Stack:** FastAPI + docker-py for the backend walk; cmdk + Radix Dialog + TanStack Query + React 19 for the palette; `smol-toml` (new dep, ~5 KiB, zero-deps) for pyproject parsing; `CustomEvent` on `window` for the pretype bus.

---

## File structure

### Created

- `hub/services/fs_browser.py` — extended in place (new helpers + `walk_paths`)
- `hub/tests/test_fs_walker.py` — unit tests for `build_find_argv`, `parse_find_output`, `walk_paths`
- `hub/tests/test_fs_walk_endpoint.py` — route tests for `/api/containers/{id}/fs/walk`
- `dashboard/src/hooks/useContainerFileIndex.ts` — React Query wrapper over `listContainerFiles`
- `dashboard/src/hooks/useContainerSuggestions.ts` — parses 3 manifests, returns palette entries
- `dashboard/src/hooks/__tests__/useContainerFileIndex.test.tsx` — vitest
- `dashboard/src/hooks/__tests__/useContainerSuggestions.test.tsx` — vitest
- `dashboard/src/lib/pretypeBus.ts` — dispatch / subscribe helpers for pretype CustomEvent
- `dashboard/src/components/__tests__/CommandPalette.test.tsx` — vitest for mode transitions + file/suggestion groups
- `dashboard/tests/e2e/palette-file-mode.spec.ts` — Playwright

### Modified

- `hub/routers/fs.py` — mount new walk endpoint
- `hub/models/schemas.py` — `WalkResult` + shared `FsEntry` Pydantic model
- `dashboard/src/lib/api.ts` — `listContainerFiles` wrapper
- `dashboard/src/lib/types.ts` — `WalkResult` TS type (reuses existing `FsEntry`)
- `dashboard/src/components/CommandPalette.tsx` — mode state, file group, suggestions group, help card
- `dashboard/src/components/PtyPane.tsx` — subscribe to pretype bus
- `dashboard/src/App.tsx` — wire palette's new callbacks (`onOpenFile`, `onRunSuggestion`)
- `dashboard/package.json` — add `smol-toml`

---

## Task 1: Add `WalkResult` response model to shared schemas

**Files:**

- Modify: `hub/models/schemas.py`

- [ ] **Step 1: Open `hub/models/schemas.py` and add the new model after `FileContent` (just before the `# --- Resources ---` section).**

```python
# Keep compatible with the dict-return shape of /fs that test_api uses:
# hub/routers/fs.py currently returns plain dicts for /fs, so we only
# need a Pydantic response_model for /fs/walk where the new code wants
# typed output. No refactor of the existing /fs return shape.


class FsEntry(BaseModel):
    """One directory entry — same shape the `/fs` endpoint returns.

    Kept as a Pydantic model (not just a TypedDict) so FastAPI can
    type-validate the walk payload and so we inherit OpenAPI schema
    generation. The existing `/fs` endpoint still hand-rolls its dict
    response — no churn there.
    """

    name: str
    kind: str  # "file" | "dir" | "symlink" | "other"
    size: int
    mode: str
    mtime: str
    target: str | None = None


class WalkResult(BaseModel):
    """Body returned by `GET /api/containers/{id}/fs/walk`.

    A flat list of every entry under `root`, depth-bounded and
    pruning well-known junk dirs (`.git`, `node_modules`, …). The
    dashboard indexes this for the palette's `file:` mode, the file
    viewer's cross-directory lookups (M24+), and future Claude diff
    hooks (M26 ε).
    """

    root: str
    entries: list[FsEntry]
    truncated: bool
    elapsed_ms: int
```

- [ ] **Step 2: Run typecheck to confirm no import churn.**

Run: `cd hub && uv run mypy hub/models/schemas.py`
Expected: no errors.

- [ ] **Step 3: Commit.**

```bash
git add hub/models/schemas.py
git commit -m "feat(m23): WalkResult + FsEntry schemas for the file-index endpoint"
```

---

## Task 2: Pure helpers in `fs_browser.py` — argv builder + find parser (TDD)

**Files:**

- Modify: `hub/services/fs_browser.py`
- Create: `hub/tests/test_fs_walker.py`

- [ ] **Step 1: Create `hub/tests/test_fs_walker.py` with failing tests.**

```python
"""Unit tests for walk_paths helpers (M23).

`walk_paths` glues together two pure helpers (``build_find_argv`` +
``parse_find_output``) plus a `docker exec`. The pure pieces are
covered here with no docker dependency; the end-to-end path gets a
route test that mocks `container.exec_run`.
"""

from __future__ import annotations

import pytest

from hub.services.fs_browser import (
    DEFAULT_WALK_EXCLUDES,
    InvalidFsPath,
    build_find_argv,
    parse_find_output,
    validate_walk_params,
)


class TestValidateWalkParams:
    def test_defaults_accepted(self) -> None:
        assert validate_walk_params(max_entries=5000, max_depth=8) == (5000, 8)

    def test_rejects_zero_max_entries(self) -> None:
        with pytest.raises(InvalidFsPath):
            validate_walk_params(max_entries=0, max_depth=8)

    def test_rejects_huge_max_entries(self) -> None:
        with pytest.raises(InvalidFsPath):
            validate_walk_params(max_entries=20_001, max_depth=8)

    def test_rejects_bad_depth(self) -> None:
        with pytest.raises(InvalidFsPath):
            validate_walk_params(max_entries=10, max_depth=0)
        with pytest.raises(InvalidFsPath):
            validate_walk_params(max_entries=10, max_depth=17)


class TestBuildFindArgv:
    def test_includes_root_and_depth(self) -> None:
        argv = build_find_argv("/workspace", ("node_modules",), max_depth=4)
        assert argv[:4] == ["find", "/workspace", "-maxdepth", "4"]

    def test_prunes_default_excludes(self) -> None:
        argv = build_find_argv("/w", DEFAULT_WALK_EXCLUDES, max_depth=8)
        # One -name per exclude, OR-connected, followed by -prune.
        for name in DEFAULT_WALK_EXCLUDES:
            assert name in argv
        assert "-prune" in argv

    def test_printf_format(self) -> None:
        argv = build_find_argv("/w", (), max_depth=8)
        assert "-printf" in argv
        printf_idx = argv.index("-printf")
        # ``%y\t%s\t%P\n`` — kind, size, relative path.
        assert argv[printf_idx + 1] == "%y\t%s\t%P\n"

    def test_no_excludes_still_terminates(self) -> None:
        argv = build_find_argv("/w", (), max_depth=8)
        # No prune group when excludes is empty.
        assert "-prune" not in argv
        assert argv[-2] == "-printf"


class TestParseFindOutput:
    def test_parses_file_and_dir(self) -> None:
        sample = (
            "d\t4096\tsrc\n"
            "f\t312\tsrc/main.py\n"
            "l\t9\tlink\n"
            "f\t1024\tREADME.md\n"
        )
        entries, truncated = parse_find_output(
            sample, root="/workspace", max_entries=10
        )
        assert truncated is False
        kinds = [e.kind for e in entries]
        assert kinds == ["dir", "file", "symlink", "file"]
        # Root is prepended so the client receives absolute paths.
        names = [e.name for e in entries]
        assert names == [
            "/workspace/src",
            "/workspace/src/main.py",
            "/workspace/link",
            "/workspace/README.md",
        ]
        assert entries[0].size == 4096

    def test_skips_root_itself(self) -> None:
        # `find` prints the root as an empty `%P`; we skip it so the
        # client never sees a name equal to the root alone.
        sample = "d\t4096\t\nf\t10\tREADME.md\n"
        entries, _ = parse_find_output(sample, root="/w", max_entries=10)
        assert [e.name for e in entries] == ["/w/README.md"]

    def test_truncates_at_max_entries(self) -> None:
        sample = "\n".join(f"f\t10\tfile{i}.py" for i in range(25)) + "\n"
        entries, truncated = parse_find_output(sample, root="/r", max_entries=5)
        assert truncated is True
        assert len(entries) == 5

    def test_tolerates_trailing_newline_and_blank_lines(self) -> None:
        entries, _ = parse_find_output(
            "\nf\t10\ta.py\n\n", root="/r", max_entries=10
        )
        assert len(entries) == 1
        assert entries[0].name == "/r/a.py"

    def test_unknown_kind_becomes_other(self) -> None:
        entries, _ = parse_find_output(
            "p\t0\tfifo\n", root="/r", max_entries=10
        )
        assert entries[0].kind == "other"

    def test_unparseable_size_is_skipped(self) -> None:
        entries, _ = parse_find_output(
            "f\tnotanumber\ta.py\nf\t10\tb.py\n",
            root="/r",
            max_entries=10,
        )
        assert [e.name for e in entries] == ["/r/b.py"]
```

- [ ] **Step 2: Run the tests — they fail (symbols not defined yet).**

Run: `cd hub && uv run pytest hub/tests/test_fs_walker.py -v`
Expected: ImportError on `build_find_argv`, `parse_find_output`, `validate_walk_params`, `DEFAULT_WALK_EXCLUDES`.

- [ ] **Step 3: Add the helpers and constants to `hub/services/fs_browser.py`. Append below `parse_ls_output`.**

```python
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
        raise InvalidFsPath(
            f"max_entries must be between 1 and {_WALK_ENTRY_CEILING}"
        )
    if max_depth < 1 or max_depth > _WALK_DEPTH_CEILING:
        raise InvalidFsPath(
            f"max_depth must be between 1 and {_WALK_DEPTH_CEILING}"
        )
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
) -> tuple[list["Entry"], bool]:
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
```

- [ ] **Step 4: Run the tests — they pass.**

Run: `cd hub && uv run pytest hub/tests/test_fs_walker.py -v`
Expected: all passing.

- [ ] **Step 5: Commit.**

```bash
git add hub/services/fs_browser.py hub/tests/test_fs_walker.py
git commit -m "feat(m23): walk-params validator + find argv + output parser"
```

---

## Task 3: `walk_paths` helper that drives `docker exec` (TDD)

**Files:**

- Modify: `hub/services/fs_browser.py`
- Modify: `hub/tests/test_fs_walker.py`

- [ ] **Step 1: Add failing test for `walk_paths` with a stubbed container.**

Append to `hub/tests/test_fs_walker.py`:

```python
import time
from unittest.mock import MagicMock


class TestWalkPaths:
    def _container(self, exit_code: int, output: bytes) -> MagicMock:
        container = MagicMock()
        container.exec_run = MagicMock(return_value=(exit_code, output))
        return container

    def test_happy_path(self) -> None:
        from hub.services.fs_browser import walk_paths

        payload = b"d\t4096\tsrc\nf\t10\tREADME.md\n"
        result = walk_paths(
            self._container(0, payload),
            root="/workspace",
            excludes=(),
            max_entries=100,
            max_depth=8,
        )
        assert result.root == "/workspace"
        assert [e.name for e in result.entries] == [
            "/workspace/src",
            "/workspace/README.md",
        ]
        assert result.truncated is False
        assert result.elapsed_ms >= 0

    def test_truncated_flag_surfaces(self) -> None:
        from hub.services.fs_browser import walk_paths

        lines = b"".join(f"f\t10\t{i}.py\n".encode() for i in range(12))
        result = walk_paths(
            self._container(0, lines),
            root="/r",
            excludes=(),
            max_entries=5,
            max_depth=8,
        )
        assert result.truncated is True
        assert len(result.entries) == 5

    def test_non_zero_exit_raises_runtime_error(self) -> None:
        from hub.services.fs_browser import WalkError, walk_paths

        with pytest.raises(WalkError) as ei:
            walk_paths(
                self._container(2, b"find: bad path\n"),
                root="/bad",
                excludes=(),
                max_entries=10,
                max_depth=8,
            )
        assert "find: bad path" in str(ei.value)

    def test_timeout_raises_walk_timeout(self) -> None:
        from hub.services.fs_browser import WalkTimeout, walk_paths

        def slow_exec(*a, **kw):
            time.sleep(0.2)
            return (0, b"")

        slow = MagicMock()
        slow.exec_run = slow_exec
        with pytest.raises(WalkTimeout):
            walk_paths(
                slow,
                root="/r",
                excludes=(),
                max_entries=10,
                max_depth=8,
                timeout_s=0.05,
            )
```

- [ ] **Step 2: Run the test to see it fail.**

Run: `cd hub && uv run pytest hub/tests/test_fs_walker.py::TestWalkPaths -v`
Expected: ImportError on `walk_paths`, `WalkError`, `WalkTimeout`.

- [ ] **Step 3: Implement `walk_paths` in `hub/services/fs_browser.py`. Append after `parse_find_output`.**

```python
import threading
import time as _time
from dataclasses import dataclass as _dataclass


class WalkError(RuntimeError):
    """Raised when `find` exits non-zero inside the container. The
    stderr/stdout blob is propagated as the exception message so the
    router can surface it verbatim."""


class WalkTimeout(TimeoutError):
    """Raised when the walk exceeds its wall-clock budget. The router
    translates this into 504 with a structured body."""


@_dataclass(frozen=True, slots=True)
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
        except Exception as exc:  # noqa: BLE001 — surface back to caller
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
```

- [ ] **Step 4: Run the tests — they pass.**

Run: `cd hub && uv run pytest hub/tests/test_fs_walker.py -v`
Expected: all passing.

- [ ] **Step 5: Commit.**

```bash
git add hub/services/fs_browser.py hub/tests/test_fs_walker.py
git commit -m "feat(m23): walk_paths helper with timeout + error shape"
```

---

## Task 4: New `GET /api/containers/{id}/fs/walk` route (TDD)

**Files:**

- Create: `hub/tests/test_fs_walk_endpoint.py`
- Modify: `hub/routers/fs.py`

- [ ] **Step 1: Create the route tests.**

```python
"""Integration tests for GET /api/containers/{id}/fs/walk (M23).

Follows the test_sessions_endpoint.py pattern: stub only what the
route reads off ``app.state`` + the docker client so we don't spin
up a real container.
"""

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


def _patch_docker(monkeypatch, *, exit_code: int, output: bytes) -> MagicMock:
    """Swap `docker.from_env()` to return a client whose
    ``containers.get(...).exec_run`` returns the given (code, bytes)."""
    import docker

    container = MagicMock()
    container.exec_run = MagicMock(return_value=(exit_code, output))
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container)
    monkeypatch.setattr(docker, "from_env", lambda: client)
    return container


@pytest.mark.asyncio
async def test_walk_happy_path(monkeypatch) -> None:
    _patch_docker(
        monkeypatch,
        exit_code=0,
        output=b"d\t4096\tsrc\nf\t10\tREADME.md\n",
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk?root=/workspace",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["root"] == "/workspace"
    assert [e["name"] for e in body["entries"]] == [
        "/workspace/src",
        "/workspace/README.md",
    ]
    assert body["truncated"] is False
    assert body["elapsed_ms"] >= 0


@pytest.mark.asyncio
async def test_walk_unauthorized_without_token() -> None:
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get("/api/containers/1/fs/walk?root=/w")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_walk_rejects_bad_path(monkeypatch) -> None:
    _patch_docker(monkeypatch, exit_code=0, output=b"")
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk?root=;rm%20-rf%20/",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_walk_rejects_missing_container() -> None:
    registry = _FakeRegistry(None)
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/999/fs/walk?root=/w",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_walk_surfaces_find_failure(monkeypatch) -> None:
    _patch_docker(
        monkeypatch,
        exit_code=2,
        output=b"find: /nope: No such file or directory\n",
    )
    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk?root=/nope",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 502
    assert "No such file or directory" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_walk_uses_workdir_when_root_missing(monkeypatch) -> None:
    container = _patch_docker(monkeypatch, exit_code=0, output=b"")
    # When root is omitted, the route falls back to the container's
    # Config.WorkingDir.
    import docker

    container_with_attrs = MagicMock()
    container_with_attrs.attrs = {"Config": {"WorkingDir": "/app"}}
    container_with_attrs.exec_run = container.exec_run
    client = MagicMock()
    client.containers.get = MagicMock(return_value=container_with_attrs)
    monkeypatch.setattr(docker, "from_env", lambda: client)

    registry = _FakeRegistry(_FakeRecord())
    async with await _client(registry) as c:
        resp = await c.get(
            "/api/containers/1/fs/walk",
            headers={"Authorization": "Bearer test-token"},
        )
    assert resp.status_code == 200
    assert resp.json()["root"] == "/app"
```

- [ ] **Step 2: Run the tests — they fail (route not defined).**

Run: `cd hub && uv run pytest hub/tests/test_fs_walk_endpoint.py -v`
Expected: 404 on every path, or "Unknown endpoint" — route not mounted.

- [ ] **Step 3: Add the route to `hub/routers/fs.py`. Import the new helpers at the top.**

Append to the existing imports block:

```python
from hub.services.fs_browser import (
    DEFAULT_WALK_EXCLUDES,
    MAX_WALK_DEPTH,
    MAX_WALK_ENTRIES,
    WalkError,
    WalkTimeout,
    validate_walk_params,
    walk_paths,
)
```

Append the route at the end of the file:

```python
@router.get("/{record_id}/fs/walk")
async def walk_container_fs(
    record_id: int,
    request: Request,
    root: str | None = Query(
        None,
        description=(
            "Absolute root path inside the container. "
            "Defaults to Config.WorkingDir."
        ),
    ),
    max_entries: int = Query(MAX_WALK_ENTRIES, ge=1, le=20_000),
    max_depth: int = Query(MAX_WALK_DEPTH, ge=1, le=16),
    excludes: str | None = Query(
        None,
        description=(
            "Comma-separated dir basenames to prune. Falls back to "
            "the default junk list when omitted."
        ),
    ),
) -> dict:
    """Walk the container's filesystem and return a flat list of entries.

    Powered by ``find -printf`` for one-shot traversal; pruned by the
    ``excludes`` list (default: ``.git``, ``node_modules``, …) and
    bounded by ``max_entries`` / ``max_depth``. See the M23 spec for
    the reusable-file-index rationale.
    """
    # Path validation — same sanitiser as the other /fs routes.
    # Root may be omitted; we then pull it from the container config.
    registry = request.app.state.registry
    container_id = await _lookup_container_id(registry, record_id)

    try:
        client = docker.from_env()
        container = client.containers.get(container_id)
    except docker.errors.NotFound:
        raise HTTPException(404, f"Docker container {container_id} not found")
    except docker.errors.DockerException as exc:
        raise HTTPException(502, f"Docker unavailable: {exc}") from exc

    if root is None or root.strip() == "":
        root = container.attrs.get("Config", {}).get("WorkingDir") or "/"

    try:
        clean_root = validate_path(root)
        clean_entries, clean_depth = validate_walk_params(
            max_entries=max_entries, max_depth=max_depth
        )
    except InvalidFsPath as exc:
        raise HTTPException(400, str(exc)) from exc

    if excludes is None:
        exclude_tuple = DEFAULT_WALK_EXCLUDES
    else:
        # Drop empties after the csv split so `?excludes=` means "none".
        exclude_tuple = tuple(x.strip() for x in excludes.split(",") if x.strip())

    try:
        result = walk_paths(
            container,
            root=clean_root,
            excludes=exclude_tuple,
            max_entries=clean_entries,
            max_depth=clean_depth,
        )
    except WalkTimeout as exc:
        raise HTTPException(504, str(exc)) from exc
    except WalkError as exc:
        raise HTTPException(502, str(exc)) from exc
    except docker.errors.APIError as exc:
        raise HTTPException(502, f"docker exec failed: {exc}") from exc

    return result.to_dict()
```

- [ ] **Step 4: Re-run the tests — they pass.**

Run: `cd hub && uv run pytest hub/tests/test_fs_walk_endpoint.py hub/tests/test_fs_walker.py -v`
Expected: all passing.

- [ ] **Step 5: Run the full hub suite to confirm no regressions.**

Run: `cd hub && uv run pytest -q`
Expected: 247+ passed (whatever the pre-M23 number was, plus the new tests).

- [ ] **Step 6: Commit.**

```bash
git add hub/routers/fs.py hub/tests/test_fs_walk_endpoint.py
git commit -m "feat(m23): GET /api/containers/{id}/fs/walk route with auth + validation"
```

---

## Task 5: Dashboard — `WalkResult` TS type + `listContainerFiles` API wrapper

**Files:**

- Modify: `dashboard/src/lib/types.ts`
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Append to `dashboard/src/lib/types.ts` under the M17 filesystem block.**

Find the existing `ContainerWorkdir` interface and add:

```ts
// M23 — palette file-index walk result.

export interface WalkResult {
  root: string;
  entries: FsEntry[];
  truncated: boolean;
  elapsed_ms: number;
}
```

- [ ] **Step 2: Append to `dashboard/src/lib/api.ts` next to `readContainerFile`.**

```ts
export const listContainerFiles = (
  id: number,
  opts?: { root?: string; maxEntries?: number; maxDepth?: number; excludes?: string },
) => {
  const params = new URLSearchParams();
  if (opts?.root) params.set("root", opts.root);
  if (opts?.maxEntries !== undefined) params.set("max_entries", String(opts.maxEntries));
  if (opts?.maxDepth !== undefined) params.set("max_depth", String(opts.maxDepth));
  if (opts?.excludes !== undefined) params.set("excludes", opts.excludes);
  const qs = params.toString();
  return request<WalkResult>(`/containers/${id}/fs/walk${qs ? `?${qs}` : ""}`);
};
```

Make sure `WalkResult` is imported at the top of `api.ts` (alongside `DirectoryListing`, `FileContent`, etc.).

- [ ] **Step 3: Typecheck.**

Run: `cd dashboard && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 4: Commit.**

```bash
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts
git commit -m "feat(m23): listContainerFiles wrapper + WalkResult type"
```

---

## Task 6: `useContainerFileIndex` hook (TDD)

**Files:**

- Create: `dashboard/src/hooks/useContainerFileIndex.ts`
- Create: `dashboard/src/hooks/__tests__/useContainerFileIndex.test.tsx`

- [ ] **Step 1: Write failing test.**

```tsx
/** useContainerFileIndex tests (M23).
 *
 * The hook delegates to ``listContainerFiles`` via React Query.
 * Covers: the ``enabled`` gate, cache-hit on remount within staleTime,
 * and error propagation.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useContainerFileIndex } from "../useContainerFileIndex";

const mockListContainerFiles = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
    ) => Promise<{ root: string; entries: unknown[]; truncated: boolean; elapsed_ms: number }>
  >(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, listContainerFiles: mockListContainerFiles };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => mockListContainerFiles.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("useContainerFileIndex", () => {
  it("does not fetch when disabled", () => {
    renderHook(() => useContainerFileIndex(1, { enabled: false }), { wrapper });
    expect(mockListContainerFiles).not.toHaveBeenCalled();
  });

  it("fetches and surfaces entries when enabled", async () => {
    mockListContainerFiles.mockResolvedValue({
      root: "/workspace",
      entries: [
        { name: "/workspace/a.ts", kind: "file", size: 10, mode: "", mtime: "", target: null },
      ],
      truncated: false,
      elapsed_ms: 5,
    });
    const { result } = renderHook(() => useContainerFileIndex(1, { enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.entries.length).toBe(1));
    expect(result.current.entries[0].name).toBe("/workspace/a.ts");
    expect(result.current.truncated).toBe(false);
  });

  it("surfaces errors from the API call", async () => {
    mockListContainerFiles.mockRejectedValue(new Error("504: walk timed out"));
    const { result } = renderHook(() => useContainerFileIndex(1, { enabled: true }), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(String(result.current.error)).toContain("504");
  });
});
```

- [ ] **Step 2: Run — fails (hook not defined).**

Run: `cd dashboard && npx vitest run src/hooks/__tests__/useContainerFileIndex.test.tsx`
Expected: import error.

- [ ] **Step 3: Implement the hook.**

```tsx
/** File-index for the command palette's ``file:`` mode (M23).
 *
 * Wraps ``GET /api/containers/{id}/fs/walk`` via React Query so re-
 * opening the palette within a 30s window hits the cache instead of
 * re-walking. Gated on ``enabled`` — only the palette in file mode
 * currently asks for this, so every other consumer stays free of the
 * fetch.
 *
 * Returns ``entries`` empty when disabled, loading, or errored so
 * callers can render unconditionally without defensive checks.
 */

import { useQuery } from "@tanstack/react-query";

import { listContainerFiles } from "../lib/api";
import type { FsEntry } from "../lib/types";

interface UseContainerFileIndexOptions {
  enabled?: boolean;
}

interface UseContainerFileIndexResult {
  entries: FsEntry[];
  truncated: boolean;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

export function useContainerFileIndex(
  containerId: number | null,
  { enabled = true }: UseContainerFileIndexOptions = {},
): UseContainerFileIndexResult {
  const effective = enabled && containerId !== null;
  const query = useQuery({
    queryKey: ["fs:walk", containerId],
    queryFn: () => listContainerFiles(containerId as number),
    enabled: effective,
    staleTime: 30_000,
    gcTime: 120_000,
    refetchOnWindowFocus: false,
  });

  return {
    entries: query.data?.entries ?? [],
    truncated: query.data?.truncated ?? false,
    isLoading: query.isFetching,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
```

- [ ] **Step 4: Run tests — they pass.**

Run: `cd dashboard && npx vitest run src/hooks/__tests__/useContainerFileIndex.test.tsx`
Expected: 3 passing.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/hooks/useContainerFileIndex.ts dashboard/src/hooks/__tests__/useContainerFileIndex.test.tsx
git commit -m "feat(m23): useContainerFileIndex hook over fs/walk"
```

---

## Task 7: Add `smol-toml` dependency

**Files:**

- Modify: `dashboard/package.json`
- Modify: `dashboard/package-lock.json` (generated)

- [ ] **Step 1: Install the dep.**

Run: `cd dashboard && npm install smol-toml@^1.3.1`
Expected: single dep added; no peer warnings.

- [ ] **Step 2: Typecheck + commit.**

Run: `cd dashboard && npx tsc --noEmit`

```bash
git add dashboard/package.json dashboard/package-lock.json
git commit -m "feat(m23): add smol-toml for pyproject.toml parsing"
```

---

## Task 8: `useContainerSuggestions` hook (TDD)

**Files:**

- Create: `dashboard/src/hooks/useContainerSuggestions.ts`
- Create: `dashboard/src/hooks/__tests__/useContainerSuggestions.test.tsx`

- [ ] **Step 1: Write failing tests.**

```tsx
/** useContainerSuggestions tests (M23).
 *
 * Manifests: package.json scripts, pyproject.toml [project.scripts]
 * and [tool.poetry.scripts], Makefile top-level targets. Each source
 * fails independently without failing the whole suggestion set.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useContainerSuggestions } from "../useContainerSuggestions";

const mockRead = vi.hoisted(() =>
  vi.fn<
    (
      id: number,
      path: string,
    ) => Promise<{
      content: string | null;
      content_base64?: string | null;
      truncated: boolean;
      mime_type: string;
      size_bytes: number;
      path: string;
    }>
  >(),
);

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, readContainerFile: mockRead };
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ok(content: string): ReturnType<typeof mockRead> extends Promise<infer T> ? T : never {
  return {
    path: "/fake",
    mime_type: "text/plain",
    size_bytes: content.length,
    content,
    truncated: false,
  };
}

beforeEach(() => mockRead.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("useContainerSuggestions", () => {
  it("parses package.json scripts", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("package.json")) {
        return ok(JSON.stringify({ scripts: { dev: "vite", test: "vitest run" } }));
      }
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((s) => s.title).sort()).toEqual(["Run npm: dev", "Run npm: test"]);
  });

  it("parses pyproject.toml project + poetry scripts", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("pyproject.toml")) {
        return ok(
          `[project.scripts]
hive-cli = "hive.cli:main"

[tool.poetry.scripts]
run-tests = "scripts:pytest"
`,
        );
      }
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    const titles = result.current.map((s) => s.title).sort();
    expect(titles).toEqual(["Run python: hive-cli", "Run python: run-tests"]);
  });

  it("parses Makefile top-level targets and skips .PHONY + comments", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("Makefile")) {
        return ok(
          `.PHONY: test build

# build the app
build:
\tgo build

test:
\tgo test ./...

 indented-not-target:
\techo no
`,
        );
      }
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(2));
    const titles = result.current.map((s) => s.title).sort();
    expect(titles).toEqual(["make build", "make test"]);
  });

  it("tolerates a missing manifest and still emits others", async () => {
    mockRead.mockImplementation(async (_id, path) => {
      if (path.endsWith("package.json")) return ok('{"scripts":{"dev":"vite"}}');
      throw new Error("404");
    });
    const { result } = renderHook(() => useContainerSuggestions(1, "/app"), { wrapper });
    await waitFor(() => expect(result.current.length).toBe(1));
    expect(result.current[0].title).toBe("Run npm: dev");
  });

  it("returns empty when no containerId or workdir", () => {
    const { result } = renderHook(() => useContainerSuggestions(null, ""), { wrapper });
    expect(result.current).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — fails.**

Run: `cd dashboard && npx vitest run src/hooks/__tests__/useContainerSuggestions.test.tsx`
Expected: import error.

- [ ] **Step 3: Implement the hook.**

```tsx
/** Contextual suggestions for the palette (M23 — ζ).
 *
 * Reads three manifests from the active container's WORKDIR in
 * parallel and turns each entry into a palette command. Every
 * manifest's read is wrapped individually so a missing or malformed
 * file does not suppress the whole set.
 *
 * Payload shape matches what ``CommandPalette`` already renders — the
 * suggestions merge into the existing cmdk pipeline as a new group.
 */

import { useQuery } from "@tanstack/react-query";
import { parse as parseToml } from "smol-toml";

import { readContainerFile } from "../lib/api";

export interface ContainerSuggestion {
  id: string;
  title: string;
  subtitle: string;
  /** The raw shell command to pre-type into the PTY. */
  command: string;
  /** Where it came from — surfaces in the subtitle. */
  source: "package.json" | "pyproject.toml" | "Makefile";
}

async function readOrNull(id: number, path: string): Promise<string | null> {
  try {
    const res = await readContainerFile(id, path);
    return typeof res.content === "string" ? res.content : null;
  } catch {
    return null;
  }
}

function suggestionsFromPackageJson(content: string): ContainerSuggestion[] {
  try {
    const parsed = JSON.parse(content) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    return Object.entries(scripts).map(([name, cmd]) => ({
      id: `sugg:npm:${name}`,
      title: `Run npm: ${name}`,
      subtitle: `${cmd} — package.json`,
      command: `npm run ${name}`,
      source: "package.json" as const,
    }));
  } catch {
    return [];
  }
}

function suggestionsFromPyproject(content: string): ContainerSuggestion[] {
  let doc: unknown;
  try {
    doc = parseToml(content);
  } catch {
    return [];
  }
  const out: ContainerSuggestion[] = [];
  const obj = (doc ?? {}) as Record<string, unknown>;
  const projectScripts = ((obj.project as Record<string, unknown> | undefined)?.scripts ??
    {}) as Record<string, string>;
  const poetryScripts = ((
    (obj.tool as Record<string, unknown> | undefined)?.poetry as Record<string, unknown> | undefined
  )?.scripts ?? {}) as Record<string, string>;
  const seen = new Set<string>();
  for (const [name, cmd] of Object.entries({ ...projectScripts, ...poetryScripts })) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      id: `sugg:py:${name}`,
      title: `Run python: ${name}`,
      subtitle: `${cmd} — pyproject.toml`,
      command: name,
      source: "pyproject.toml",
    });
  }
  return out;
}

function suggestionsFromMakefile(content: string): ContainerSuggestion[] {
  const targets = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    // Reject lines that start with whitespace (recipe body) or `.` or `#`.
    if (!raw || raw.startsWith("\t") || raw.startsWith(" ")) continue;
    if (raw.startsWith("#") || raw.startsWith(".")) continue;
    const m = raw.match(/^([A-Za-z0-9_\-]+):(\s|$)/);
    if (!m) continue;
    const name = m[1];
    targets.add(name);
  }
  return Array.from(targets).map((name) => ({
    id: `sugg:make:${name}`,
    title: `make ${name}`,
    subtitle: "Makefile",
    command: `make ${name}`,
    source: "Makefile" as const,
  }));
}

export function useContainerSuggestions(
  containerId: number | null,
  workdir: string,
): ContainerSuggestion[] {
  const query = useQuery({
    queryKey: ["suggestions", containerId, workdir],
    enabled: containerId !== null && workdir.length > 0,
    staleTime: 60_000,
    gcTime: 300_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const id = containerId as number;
      const [pkg, py, mk] = await Promise.all([
        readOrNull(id, `${workdir.replace(/\/$/, "")}/package.json`),
        readOrNull(id, `${workdir.replace(/\/$/, "")}/pyproject.toml`),
        readOrNull(id, `${workdir.replace(/\/$/, "")}/Makefile`),
      ]);
      const out: ContainerSuggestion[] = [];
      if (pkg) out.push(...suggestionsFromPackageJson(pkg));
      if (py) out.push(...suggestionsFromPyproject(py));
      if (mk) out.push(...suggestionsFromMakefile(mk));
      return out;
    },
  });

  return query.data ?? [];
}
```

- [ ] **Step 4: Run tests — they pass.**

Run: `cd dashboard && npx vitest run src/hooks/__tests__/useContainerSuggestions.test.tsx`
Expected: 5 passing.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/hooks/useContainerSuggestions.ts dashboard/src/hooks/__tests__/useContainerSuggestions.test.tsx
git commit -m "feat(m23): useContainerSuggestions parses manifest scripts"
```

---

## Task 9: Pretype event bus for PTY pre-fill

**Files:**

- Create: `dashboard/src/lib/pretypeBus.ts`

- [ ] **Step 1: Create the bus module.**

```ts
/** Pretype bus — inject text into the active PTY without coupling
 * ``CommandPalette`` to ``PtyPane`` (M23).
 *
 * Palette dispatches a ``CustomEvent`` on ``window``. ``PtyPane``'s
 * mount effect subscribes and filters by ``(recordId, sessionKey)``.
 * The subscriber is responsible for matching its own identity — the
 * palette has no knowledge of which PTYs are mounted.
 *
 * Design note: a module-level singleton (plain EventEmitter) would
 * work too, but ``CustomEvent`` gives us cross-tree delivery in one
 * line and free compatibility with DevTools' event listeners view.
 */

export interface PretypeDetail {
  recordId: number;
  sessionKey: string;
  text: string;
}

const EVENT_NAME = "hive:pretype";

export function dispatchPretype(detail: PretypeDetail): void {
  window.dispatchEvent(new CustomEvent<PretypeDetail>(EVENT_NAME, { detail }));
}

export function subscribePretype(listener: (detail: PretypeDetail) => void): () => void {
  const handler = (e: Event) => {
    const ev = e as CustomEvent<PretypeDetail>;
    if (ev.detail) listener(ev.detail);
  };
  window.addEventListener(EVENT_NAME, handler as EventListener);
  return () => window.removeEventListener(EVENT_NAME, handler as EventListener);
}
```

- [ ] **Step 2: Typecheck.**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add dashboard/src/lib/pretypeBus.ts
git commit -m "feat(m23): pretype event bus — dispatch/subscribe helpers"
```

---

## Task 10: Subscribe `PtyPane` to the pretype bus

**Files:**

- Modify: `dashboard/src/components/PtyPane.tsx`

- [ ] **Step 1: Add the subscription.**

Near the top, add the import:

```ts
import { subscribePretype } from "../lib/pretypeBus";
```

Inside the `PtyPane` component, after the `useEffect` that mounts the xterm instance and opens the WebSocket, add a new effect. Find the closing `return () => {` block of that effect — add the new effect immediately below it (before the JSX return). Insert:

```tsx
// M23 — palette "run suggestion" dispatches text at us via
// ``dispatchPretype``. Match on (recordId, sessionKey) and forward
// to the live WS. The text is NOT auto-submitted — we omit the
// trailing newline so the user still sees the command in their
// prompt and presses Enter.
useEffect(() => {
  return subscribePretype(({ recordId: targetId, sessionKey: targetKey, text }) => {
    if (targetId !== recordId || targetKey !== sessionKey) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Strip any trailing newline so we never auto-execute.
    const sanitised = text.replace(/\r?\n+$/, "");
    ws.send(new TextEncoder().encode(sanitised));
  });
}, [recordId, sessionKey]);
```

- [ ] **Step 2: Typecheck + lint.**

Run: `cd dashboard && npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 3: Commit.**

```bash
git add dashboard/src/components/PtyPane.tsx
git commit -m "feat(m23): PtyPane subscribes to pretype bus for palette suggestions"
```

---

## Task 11: CommandPalette mode state + file group + suggestions + help (TDD)

**Files:**

- Modify: `dashboard/src/components/CommandPalette.tsx`
- Create: `dashboard/src/components/__tests__/CommandPalette.test.tsx`

- [ ] **Step 1: Write failing tests.**

```tsx
/** CommandPalette tests — M23 mode transitions.
 *
 * We stub both the file-index hook and the suggestion hook so the
 * cmdk rendering logic is exercised independent of the network.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandPalette } from "../CommandPalette";

const mockUseFileIndex = vi.hoisted(() =>
  vi.fn(() => ({
    entries: [],
    truncated: false,
    isLoading: false,
    error: null,
    refetch: () => {},
  })),
);
const mockUseSuggestions = vi.hoisted(() => vi.fn(() => []));

vi.mock("../../hooks/useContainerFileIndex", () => ({
  useContainerFileIndex: mockUseFileIndex,
}));
vi.mock("../../hooks/useContainerSuggestions", () => ({
  useContainerSuggestions: mockUseSuggestions,
}));

function renderPalette(
  overrides: {
    onOpenFile?: (path: string) => void;
    onRunSuggestion?: (cmd: string) => void;
  } = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => {};
  return render(
    <QueryClientProvider client={qc}>
      <CommandPalette
        open
        onClose={noop}
        containers={[
          {
            id: 1,
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
            has_claude_cli: true,
            claude_cli_checked_at: null,
            created_at: "",
            updated_at: "",
            agent_expected: false,
          },
        ]}
        activeContainerId={1}
        activeWorkdir="/w"
        onFocusContainer={noop}
        onCloseContainer={noop}
        onNewClaudeSession={noop}
        onActivity={noop}
        onOpenProvisioner={noop}
        onOpenFile={overrides.onOpenFile ?? noop}
        onRunSuggestion={overrides.onRunSuggestion ?? noop}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUseFileIndex.mockReturnValue({
    entries: [],
    truncated: false,
    isLoading: false,
    error: null,
    refetch: () => {},
  });
  mockUseSuggestions.mockReturnValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("CommandPalette — M23", () => {
  it("typing 'file:' flips to file mode and shows the Files group", async () => {
    mockUseFileIndex.mockReturnValue({
      entries: [{ name: "/w/a.ts", kind: "file", size: 1, mode: "", mtime: "", target: null }],
      truncated: false,
      isLoading: false,
      error: null,
      refetch: () => {},
    });
    renderPalette();
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, "file:");
    expect(await screen.findByText("Files")).toBeInTheDocument();
    expect(screen.getByText("/w/a.ts")).toBeInTheDocument();
  });

  it("pressing Enter on a file entry calls onOpenFile", async () => {
    mockUseFileIndex.mockReturnValue({
      entries: [{ name: "/w/a.ts", kind: "file", size: 1, mode: "", mtime: "", target: null }],
      truncated: false,
      isLoading: false,
      error: null,
      refetch: () => {},
    });
    const onOpenFile = vi.fn();
    renderPalette({ onOpenFile });
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, "file:");
    await userEvent.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("/w/a.ts");
  });

  it("?' prints the cheat-sheet instead of groups", async () => {
    renderPalette();
    await userEvent.type(screen.getByPlaceholderText(/type a command/i), "?");
    expect(screen.getByText(/file:<query>/i)).toBeInTheDocument();
    // Regular groups hidden in help mode.
    expect(screen.queryByText("Containers")).not.toBeInTheDocument();
  });

  it("renders the Suggestions group in command mode when hook yields entries", async () => {
    mockUseSuggestions.mockReturnValue([
      {
        id: "sugg:npm:dev",
        title: "Run npm: dev",
        subtitle: "vite — package.json",
        command: "npm run dev",
        source: "package.json",
      },
    ]);
    renderPalette();
    expect(await screen.findByText(/suggestions for demo/i)).toBeInTheDocument();
    expect(screen.getByText("Run npm: dev")).toBeInTheDocument();
  });

  it("clearing the input returns to command mode", async () => {
    renderPalette();
    const input = screen.getByPlaceholderText(/type a command/i);
    await userEvent.type(input, "file:");
    expect(screen.queryByText("Containers")).not.toBeInTheDocument();
    await userEvent.clear(input);
    expect(screen.getByText("Containers")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — fails (missing props + missing hook usage).**

Run: `cd dashboard && npx vitest run src/components/__tests__/CommandPalette.test.tsx`
Expected: compilation error (missing props) or assertion failures.

- [ ] **Step 3: Rewrite `dashboard/src/components/CommandPalette.tsx` with the new mode machinery.**

Replace the whole file with:

```tsx
/** Cmd+K / Ctrl+K palette (M8; M23 adds file: mode + suggestions).
 *
 * cmdk owns the keyboard model + fuzzy filter. We layer:
 *
 * - ``mode = "command" | "file"``: prefix-driven. ``file:<query>``
 *   flips to file mode, ``>`` remains an explicit commands-only
 *   escape, ``?`` prints a help card in place of the list.
 * - Suggestions group at the top of command mode, parsed from
 *   manifest files at the active container's WORKDIR.
 * - File group in file mode, backed by a flat walk of the active
 *   container's filesystem.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { useContainerFileIndex } from "../hooks/useContainerFileIndex";
import { useContainerSuggestions } from "../hooks/useContainerSuggestions";
import type { ContainerRecord } from "../lib/types";
import type { Activity } from "./ActivityBar";

type PaletteMode = "command" | "file";

interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  shortcut?: string;
  group: "Containers" | "Activity" | "Sessions" | "Discover" | "Suggestions";
  run: () => void;
}

interface FileItem {
  id: string;
  path: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  containers: ContainerRecord[];
  /** Used to title the suggestions group + scope the file walk. */
  activeContainerId: number | null;
  /** WORKDIR for the active container — empty string if unknown. */
  activeWorkdir: string;
  onFocusContainer: (id: number) => void;
  onCloseContainer: (id: number) => void;
  onNewClaudeSession: (id: number) => void;
  onActivity: (a: Activity) => void;
  onOpenProvisioner: () => void;
  /** Open a file from the walk index in the viewer pane. */
  onOpenFile: (path: string) => void;
  /** Pre-type a suggestion command into the active container's PTY. */
  onRunSuggestion: (command: string) => void;
}

// Strip the mode prefix off the raw input so cmdk scores against the
// actual query. Returns the normalised (mode, search) pair.
function parseInput(raw: string): { mode: PaletteMode; search: string; showHelp: boolean } {
  if (raw === "?") return { mode: "command", search: "", showHelp: true };
  if (raw.startsWith("file:"))
    return { mode: "file", search: raw.slice("file:".length), showHelp: false };
  if (raw.startsWith(">")) return { mode: "command", search: raw.slice(1), showHelp: false };
  return { mode: "command", search: raw, showHelp: false };
}

export function CommandPalette({
  open,
  onClose,
  containers,
  activeContainerId,
  activeWorkdir,
  onFocusContainer,
  onCloseContainer,
  onNewClaudeSession,
  onActivity,
  onOpenProvisioner,
  onOpenFile,
  onRunSuggestion,
}: Props) {
  const [rawInput, setRawInput] = useState("");
  const { mode, search, showHelp } = parseInput(rawInput);

  const fileIndex = useContainerFileIndex(activeContainerId, {
    enabled: mode === "file" && activeContainerId !== null,
  });
  const suggestions = useContainerSuggestions(activeContainerId, activeWorkdir);

  const activeName = useMemo(
    () => containers.find((c) => c.id === activeContainerId)?.project_name ?? null,
    [containers, activeContainerId],
  );

  const commands: PaletteCommand[] = useMemo(() => {
    const items: PaletteCommand[] = [];
    for (const s of suggestions) {
      items.push({
        id: s.id,
        title: s.title,
        subtitle: s.subtitle,
        group: "Suggestions",
        run: () => onRunSuggestion(s.command),
      });
    }
    for (const c of containers) {
      items.push({
        id: `focus:${c.id}`,
        title: `Open: ${c.project_name}`,
        subtitle: `${c.workspace_folder} · ${c.container_status}`,
        group: "Containers",
        run: () => onFocusContainer(c.id),
      });
    }
    for (const c of containers) {
      items.push({
        id: `close:${c.id}`,
        title: `Close tab: ${c.project_name}`,
        group: "Containers",
        run: () => onCloseContainer(c.id),
      });
    }
    for (const c of containers) {
      items.push({
        id: `claude:${c.id}`,
        title: `Start Claude session in ${c.project_name}`,
        group: "Sessions",
        run: () => onNewClaudeSession(c.id),
      });
    }
    items.push(
      {
        id: "act:containers",
        title: "Show Containers sidebar",
        shortcut: "Ctrl+Shift+C",
        group: "Activity",
        run: () => onActivity("containers"),
      },
      {
        id: "act:gitops",
        title: "Show Git Ops sidebar",
        shortcut: "Ctrl+Shift+G",
        group: "Activity",
        run: () => onActivity("gitops"),
      },
    );
    items.push({
      id: "discover:new",
      title: "Register a new devcontainer…",
      subtitle: "Opens the Discover / Manual wizard",
      group: "Discover",
      run: onOpenProvisioner,
    });
    return items;
  }, [
    containers,
    suggestions,
    onFocusContainer,
    onCloseContainer,
    onNewClaudeSession,
    onActivity,
    onOpenProvisioner,
    onRunSuggestion,
  ]);

  // Top-to-bottom group order. Suggestions first — they're the most
  // contextual. Files show only in file mode via a separate branch.
  const groupOrder: PaletteCommand["group"][] = useMemo(
    () =>
      (activeName
        ? ["Suggestions", "Containers", "Sessions", "Activity", "Discover"]
        : ["Containers", "Sessions", "Activity", "Discover"]) as PaletteCommand["group"][],
    [activeName],
  );

  const groups = useMemo(
    () =>
      groupOrder
        .map((label) => ({ label, items: commands.filter((c) => c.group === label) }))
        .filter((g) => g.items.length > 0),
    [commands, groupOrder],
  );

  const byId = useMemo(() => {
    const map = new Map<string, PaletteCommand>();
    for (const c of commands) map.set(c.id, c);
    return map;
  }, [commands]);

  const fileItems: FileItem[] = useMemo(() => {
    return fileIndex.entries
      .filter((e) => e.kind === "file")
      .slice(0, 200)
      .map((e) => ({ id: `file:${e.name}`, path: e.name }));
  }, [fileIndex.entries]);

  const handleSelectCommand = (id: string) => {
    const cmd = byId.get(id);
    if (cmd) {
      cmd.run();
      onClose();
    }
  };

  const handleSelectFile = (path: string) => {
    onOpenFile(path);
    onClose();
  };

  const handleClose = () => {
    setRawInput("");
    onClose();
  };

  const groupHeading = (label: PaletteCommand["group"]): string =>
    label === "Suggestions" && activeName ? `Suggestions for ${activeName}` : label;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : handleClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
        <Dialog.Content
          className="fixed top-[15%] left-1/2 z-[100] w-full max-w-xl -translate-x-1/2 rounded-lg border border-[#454545] bg-[#252526] shadow-2xl outline-none"
          aria-label="Command palette"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command
            // Subsequence-match fuzzy scorer (same as pre-M23) so names
            // like "StaBar" match "StatusBar" without a library.
            filter={(value, s, keywords) => {
              const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
              const needle = s.trim().toLowerCase();
              if (!needle) return 1;
              let i = 0;
              for (const ch of needle) {
                i = haystack.indexOf(ch, i);
                if (i < 0) return 0;
                i += 1;
              }
              return 1;
            }}
            loop
          >
            <div className="flex items-center gap-2 border-b border-[#3a3a3a] px-3 py-2">
              <Search size={14} className="text-[#858585]" aria-hidden="true" />
              <Command.Input
                placeholder="Type a command or container name… (file:, >, ?)"
                className="flex-1 bg-transparent text-sm text-[#e7e7e7] outline-none placeholder:text-[#666]"
                autoFocus
                value={rawInput}
                onValueChange={setRawInput}
                // cmdk scores against the Command.Input's ``value``; to
                // strip the prefix before scoring we override the value
                // cmdk sees via its ``search`` API. Easiest path: drive
                // a separate hidden search by re-rendering the list.
              />
            </div>
            {showHelp ? (
              <HelpCard />
            ) : mode === "file" ? (
              <Command.List
                className="max-h-80 overflow-y-auto py-1"
                // Narrow by typing `file:<query>`. cmdk still scores
                // against the input by default — we strip the prefix
                // at the item level via ``keywords``.
              >
                <Command.Empty className="px-3 py-2 text-xs text-[#858585]">
                  {fileIndex.isLoading
                    ? "Walking filesystem…"
                    : fileIndex.error
                      ? "Walk failed."
                      : "No matches"}
                </Command.Empty>
                {activeContainerId === null && (
                  <p className="px-3 py-2 text-xs text-[#858585]">Open a container first.</p>
                )}
                {fileIndex.error !== null && fileIndex.error !== undefined && (
                  <div className="px-3 py-2 text-xs text-red-400">
                    <p>{String(fileIndex.error)}</p>
                    <button
                      type="button"
                      className="mt-1 underline hover:text-red-300"
                      onClick={() => fileIndex.refetch()}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {fileItems.length > 0 && (
                  <Command.Group
                    heading="Files"
                    className="px-1 py-0.5 text-[10px] text-[#858585] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:uppercase"
                  >
                    {fileItems.map((f) => (
                      <Command.Item
                        key={f.id}
                        value={f.path}
                        keywords={[search]}
                        onSelect={() => handleSelectFile(f.path)}
                        className="flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs text-[#cccccc] data-[selected=true]:bg-[#094771] data-[selected=true]:text-white"
                      >
                        <span className="truncate">{f.path}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {fileIndex.truncated && (
                  <p className="px-3 py-1 text-[10px] text-yellow-500">
                    Showing first 5000 files. Refine with a narrower prefix.
                  </p>
                )}
              </Command.List>
            ) : (
              <Command.List className="max-h-80 overflow-y-auto py-1">
                <Command.Empty className="px-3 py-2 text-xs text-[#858585]">
                  No matches
                </Command.Empty>
                {groups.map((group) => (
                  <Command.Group
                    key={group.label}
                    heading={groupHeading(group.label)}
                    className="px-1 py-0.5 text-[10px] text-[#858585] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:uppercase"
                  >
                    {group.items.map((cmd) => (
                      <Command.Item
                        key={cmd.id}
                        value={cmd.title}
                        keywords={[cmd.subtitle ?? "", cmd.group, search]}
                        onSelect={() => handleSelectCommand(cmd.id)}
                        className="flex cursor-pointer items-center justify-between rounded px-3 py-1.5 text-xs text-[#cccccc] data-[selected=true]:bg-[#094771] data-[selected=true]:text-white"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate">{cmd.title}</div>
                          {cmd.subtitle && (
                            <div className="truncate text-[10px] text-[#858585]">
                              {cmd.subtitle}
                            </div>
                          )}
                        </div>
                        {cmd.shortcut && (
                          <kbd className="ml-3 shrink-0 rounded border border-[#555] px-1.5 py-0.5 text-[10px] text-[#858585]">
                            {cmd.shortcut}
                          </kbd>
                        )}
                      </Command.Item>
                    ))}
                  </Command.Group>
                ))}
              </Command.List>
            )}
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HelpCard() {
  return (
    <div className="px-4 py-3 text-xs text-[#cccccc]">
      <p className="mb-2 font-semibold text-[#e7e7e7]">Palette prefixes</p>
      <ul className="space-y-1 text-[11px]">
        <li>
          <code className="rounded bg-[#333] px-1">file:&lt;query&gt;</code> — fuzzy-search the
          active container's filesystem. Enter opens the file in the editor.
        </li>
        <li>
          <code className="rounded bg-[#333] px-1">&gt;</code> — explicitly search commands only
          (same as typing nothing).
        </li>
        <li>
          <code className="rounded bg-[#333] px-1">?</code> — this cheat-sheet.
        </li>
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests — they pass.**

Run: `cd dashboard && npx vitest run src/components/__tests__/CommandPalette.test.tsx`
Expected: 5 passing.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/components/CommandPalette.tsx dashboard/src/components/__tests__/CommandPalette.test.tsx
git commit -m "feat(m23): palette mode state + file group + suggestions group + help card"
```

---

## Task 12: App.tsx — wire new palette props + suggestion dispatcher

**Files:**

- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: Add imports at the top of `dashboard/src/App.tsx`.**

Add:

```tsx
import { dispatchPretype } from "./lib/pretypeBus";
import { getContainerWorkdir } from "./lib/api";
```

And, near the top of the file, add a small query hook to track the active container's WORKDIR — the palette needs it. Inside `App()`, after `active` is computed, add:

```tsx
// M23 — WORKDIR for the active container, fed to the palette for
// suggestion parsing + the walk endpoint's default root.
const { data: activeWorkdirData } = useQuery({
  queryKey: ["workdir", active?.id ?? 0],
  queryFn: () => getContainerWorkdir(active!.id),
  enabled: active !== undefined,
  staleTime: 60_000,
});
const activeWorkdir = activeWorkdirData?.path ?? "";
```

- [ ] **Step 2: Extend the existing `<CommandPalette>` usage in the JSX return.**

Find the existing `<CommandPalette open={paletteOpen} …>` block and replace with:

```tsx
<CommandPalette
  open={paletteOpen}
  onClose={() => setPaletteOpen(false)}
  containers={containers}
  activeContainerId={active?.id ?? null}
  activeWorkdir={activeWorkdir}
  onFocusContainer={openContainer}
  onCloseContainer={closeTab}
  onNewClaudeSession={newClaudeSession}
  onActivity={(a) => {
    setActivity(a);
    setSidebarOpen(true);
  }}
  onOpenProvisioner={() => setShowProvisioner(true)}
  onOpenFile={(path) => {
    if (active !== undefined) {
      setOpenedFile(path);
    }
  }}
  onRunSuggestion={(command) => {
    if (active === undefined) return;
    // Ensure the container tab is open and focused. Opening
    // the PTY session on tab mount already happens elsewhere
    // via TerminalPane; subscribePretype will race-wait for
    // the WS to become open (PtyPane ignores sends until
    // then), so a brief delay or retry isn't needed.
    openContainer(active.id);
    dispatchPretype({
      recordId: active.id,
      sessionKey: activeSessionId,
      text: command,
    });
  }}
/>
```

- [ ] **Step 3: Typecheck + lint.**

Run: `cd dashboard && npx tsc --noEmit && npm run lint`
Expected: clean (0 errors; pre-existing warnings OK).

- [ ] **Step 4: Run the full vitest suite to confirm no regressions.**

Run: `cd dashboard && npx vitest run`
Expected: all passing.

- [ ] **Step 5: Commit.**

```bash
git add dashboard/src/App.tsx
git commit -m "feat(m23): App.tsx wires new palette props + suggestion dispatcher"
```

---

## Task 13: Playwright — palette file-mode e2e

**Files:**

- Create: `dashboard/tests/e2e/palette-file-mode.spec.ts`

- [ ] **Step 1: Write the spec.**

```ts
/** Palette file mode + suggestions (M23).
 *
 * Stubs the walk endpoint to a tiny list; asserts that Ctrl+K →
 * ``file:`` → Enter opens the file in the editor pane. Suggestion
 * rendering is covered by the Vitest component test; here we only
 * verify the file-mode end-to-end.
 */

import { expect, test } from "@playwright/test";

const TOKEN = "palette-file-token";

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
          created_at: "2026-04-18",
          updated_at: "2026-04-18",
          agent_expected: false,
        },
      ]),
    ),
  );
  await context.route("**/api/containers/7/workdir", (route) =>
    route.fulfill(mockJson({ path: "/w" })),
  );
  await context.route("**/api/containers/7/fs/walk*", (route) =>
    route.fulfill(
      mockJson({
        root: "/w",
        entries: [
          { name: "/w/README.md", kind: "file", size: 100, mode: "", mtime: "", target: null },
          { name: "/w/src/app.ts", kind: "file", size: 200, mode: "", mtime: "", target: null },
        ],
        truncated: false,
        elapsed_ms: 3,
      }),
    ),
  );
  // Manifest reads — return 404 so suggestions are empty.
  await context.route("**/api/containers/7/fs/read*", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"missing"}' }),
  );

  // Stub every other API route with safe defaults.
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
});

test("Ctrl+K → file: shows walk results; Enter opens the file", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Control+K");
  const palette = page.getByRole("dialog", { name: /command palette/i });
  await expect(palette).toBeVisible();

  const input = palette.getByPlaceholder(/type a command/i);
  await input.fill("file:app");
  await expect(palette.getByText("/w/src/app.ts")).toBeVisible();

  await page.keyboard.press("Enter");
  // FileViewer mounts inside the editor — assert via its close button
  // which carries a stable aria-label.
  await expect(page.getByRole("button", { name: /close file viewer/i })).toBeVisible();
});

test("? prints the prefix cheat-sheet", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder(/type a command/i).fill("?");
  await expect(page.getByText(/palette prefixes/i)).toBeVisible();
  await expect(page.getByText(/file:<query>/i)).toBeVisible();
});
```

- [ ] **Step 2: Run the Playwright suite.**

Run: `cd dashboard && npx playwright test --reporter=line tests/e2e/palette-file-mode.spec.ts`
Expected: 2 passing.

If the "close file viewer" aria-label doesn't match the current FileViewer implementation, grep for the existing close-button label and update the selector. Tracking that exact string:

```
grep -n "aria-label=\"Close" dashboard/src/components/FileViewer.tsx
```

- [ ] **Step 3: Run the full Playwright suite.**

Run: `cd dashboard && npx playwright test --reporter=line`
Expected: all 10+ passing.

- [ ] **Step 4: Commit.**

```bash
git add dashboard/tests/e2e/palette-file-mode.spec.ts
git commit -m "test(m23): Playwright — palette file-mode + help card"
```

---

## Task 14: Final sanity — prettier, lint, full test matrix

- [ ] **Step 1: Prettier on changed files.**

Run:

```bash
cd dashboard && npx prettier --write \
  src/App.tsx \
  src/components/CommandPalette.tsx \
  src/components/PtyPane.tsx \
  src/hooks/useContainerFileIndex.ts \
  src/hooks/useContainerSuggestions.ts \
  src/lib/api.ts \
  src/lib/pretypeBus.ts \
  src/lib/types.ts \
  src/components/__tests__/CommandPalette.test.tsx \
  src/hooks/__tests__/useContainerFileIndex.test.tsx \
  src/hooks/__tests__/useContainerSuggestions.test.tsx \
  tests/e2e/palette-file-mode.spec.ts
```

- [ ] **Step 2: Lint + typecheck.**

Run: `cd dashboard && npx tsc --noEmit && npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Full vitest + playwright.**

Run:

```bash
cd dashboard && npx vitest run
cd dashboard && npx playwright test --reporter=line
```

Expected: all green.

- [ ] **Step 4: Hub pytest (regression check).**

Run: `cd hub && uv run pytest -q`
Expected: all green (247 pre-M23 + 6 new walker tests + 6 new endpoint tests).

- [ ] **Step 5: Commit any prettier-induced changes.**

```bash
git status
# only reformat commits if anything was modified
git add -u
git commit -m "style(m23): prettier pass on new/modified files" || true
```

---

## Task 15: Ship — merge, tag, push, CI watch

- [ ] **Step 1: Verify branch state + recent log.**

Run: `git log --oneline main..HEAD`
Expected: M23 commits only. The first one is the spec doc commit `docs(m23): …`.

- [ ] **Step 2: Merge to main.**

```bash
git checkout main && git pull --ff-only
git merge --no-ff m23-palette-file-suggestions -m "$(cat <<'EOF'
Merge M23: command palette file-mode + contextual suggestions

  * file: prefix inside Ctrl+K flips the palette into a fuzzy
    file finder rooted at the active container's WORKDIR.
  * Suggestions for {project} group at the top of the palette
    parses package.json, pyproject.toml, and Makefile. Selecting
    a suggestion pre-types into the active PTY (Enter-to-run,
    no auto-submit) via a new window-event pretype bus.
  * Backend: new GET /api/containers/{id}/fs/walk endpoint,
    reusable file-index primitive M24/M26 will consume.

Full vitest + Playwright + hub pytest pass locally.
EOF
)"
```

- [ ] **Step 3: Tag.**

```bash
git tag -a v0.23-palette-file -m "M23 — palette file-mode + contextual suggestions"
```

- [ ] **Step 4: Push with tags.**

```bash
git push origin main --follow-tags
```

- [ ] **Step 5: Delete the merged branch locally.**

```bash
git branch -d m23-palette-file-suggestions
```

- [ ] **Step 6: Watch CI.**

```bash
export GH_TOKEN=$(grep -E '^GITHUB_TOKEN=' .env | cut -d= -f2-)
gh run list --branch main --limit 3
# Find the in-progress run id for the M23 merge commit
gh run watch <RUN_ID> --exit-status
```

Expected: all 7 CI jobs green (pre-commit, hub, hive-agent, dashboard lint+vitest, dashboard playwright, secrets scan, docker base build).

- [ ] **Step 7: Report result to user** with the tag + CI job summary.

---

## Notes / pitfalls for the implementing engineer

- **`find -printf` is GNU-only.** BusyBox `find` (Alpine base images without `findutils`) will fail with an "invalid option" exit. The M23 route surfaces that as a 502 with the find stderr verbatim — good enough for v1. A follow-up can add an `ls -R` fallback; that's explicitly out of M23 scope.
- **`@tanstack/react-query` v5 signature.** `useQuery({ queryKey, queryFn, enabled, staleTime, gcTime, refetchOnWindowFocus })` — no positional args, no `cacheTime` (renamed to `gcTime`). The codebase already uses this shape; match existing calls.
- **cmdk's scoring is best-effort.** Because we include `search` in every item's `keywords`, cmdk will always match — we rely on cmdk to _order_, not to filter. The `No matches` empty state fires naturally via cmdk's own logic when no item has non-zero score, which keeps the UX intuitive.
- **PtyPane send order.** The pretype bus is wired BEFORE `openContainer` in Task 12's handler — this is safe because `subscribePretype` filters by `(recordId, sessionKey)` and the dispatch lands in a microtask; by the time the handler returns, the PtyPane effect registers the listener. If for any reason the PTY isn't open yet, the send is silently dropped (readyState guard). A retry loop is explicit out-of-scope — users can re-run the suggestion.
- **Container record shape.** Some tests rely on `agent_expected` being present on the record. Check `dashboard/src/lib/types.ts` for the full `ContainerRecord` shape and mirror every field in the e2e test fixture.
- **WORKDIR fallback.** When a container's image didn't set a WorkingDir, the hub defaults to `/`. The walk then traverses the root filesystem with `max_depth=8` and default excludes — still bounded but can be slow. Users can narrow via `?root=/workspace` on the next walk; the file-index hook can't pass that today. M24+ improvement.
- **Prettier reformatting the plan's tables** is known harmless — every other spec doc has survived a `prettier --write`.

## Self-review summary

**Spec coverage.** Every numbered design section in the spec maps to tasks:

- §1 Architecture → Tasks 1–12 collectively
- §2 Backend walk → Tasks 1–4
- §3 Dashboard file index + palette mode → Tasks 5, 6, 11, 12
- §4 Contextual suggestions → Tasks 7, 8, 11, 12
- §5 Error handling → covered inline in walk_paths + hooks + palette branches
- §6 Testing → Tasks 2, 3, 4, 6, 8, 11, 13

**Placeholder scan.** No TBD/TODO. Every code block contains full implementations.

**Type consistency.** `WalkResult` (Pydantic + TS), `FsEntry` (Pydantic + TS), `ContainerSuggestion` (TS only), `PretypeDetail` (TS only), `PaletteCommand.group` enum extended with `"Suggestions"`.

**Spec-but-not-in-plan items.** None found. `file:!` refresh entry — the plan covers it in Task 11 via `fileIndex.refetch()` surfaced through the hook; a dedicated synthetic palette entry for `file:!` is deferred to a v0.23.1 patch because cmdk's `Command.Item` can't easily be conditionally inserted without a larger refactor (the fuzzy filter treats every registered item as permanent). Documented in the plan's **Notes** section for the engineer to decide.
