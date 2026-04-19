"""Unit tests for walk_paths helpers (M23).

`walk_paths` glues together two pure helpers (``build_find_argv`` +
``parse_find_output``) plus a `docker exec`. The pure pieces are
covered here with no docker dependency; the end-to-end path gets a
route test that mocks `container.exec_run`.
"""

from __future__ import annotations

import time
from unittest.mock import MagicMock

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
        sample = "d\t4096\tsrc\nf\t312\tsrc/main.py\nl\t9\tlink\nf\t1024\tREADME.md\n"
        entries, truncated = parse_find_output(sample, root="/workspace", max_entries=10)
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
        entries, _ = parse_find_output("\nf\t10\ta.py\n\n", root="/r", max_entries=10)
        assert len(entries) == 1
        assert entries[0].name == "/r/a.py"

    def test_unknown_kind_becomes_other(self) -> None:
        entries, _ = parse_find_output("p\t0\tfifo\n", root="/r", max_entries=10)
        assert entries[0].kind == "other"

    def test_unparseable_size_is_skipped(self) -> None:
        entries, _ = parse_find_output(
            "f\tnotanumber\ta.py\nf\t10\tb.py\n",
            root="/r",
            max_entries=10,
        )
        assert [e.name for e in entries] == ["/r/b.py"]


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
