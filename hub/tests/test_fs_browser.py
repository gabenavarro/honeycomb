"""Unit tests for the fs_browser parser + path validator (M17)."""

from __future__ import annotations

import pytest

from hub.services.fs_browser import (
    InvalidFsPath,
    parse_ls_output,
    validate_path,
)


class TestValidatePath:
    def test_ok_absolute(self) -> None:
        assert validate_path("/workspace/app") == "/workspace/app"

    def test_strips_whitespace(self) -> None:
        assert validate_path("  /tmp/x  ") == "/tmp/x"

    def test_rejects_empty(self) -> None:
        with pytest.raises(InvalidFsPath):
            validate_path("")

    def test_rejects_relative(self) -> None:
        with pytest.raises(InvalidFsPath):
            validate_path("etc/passwd")

    def test_rejects_metacharacters(self) -> None:
        for bad in (
            "/etc/passwd;ls",
            "/workspace/`whoami`",
            "/workspace|cat",
            "/workspace&amp",
            "/work\nspace",
        ):
            with pytest.raises(InvalidFsPath):
                validate_path(bad)

    def test_rejects_dot_dot(self) -> None:
        with pytest.raises(InvalidFsPath):
            validate_path("/workspace/../etc")


class TestParseLsOutput:
    SAMPLE = (
        "total 12\n"
        "drwxr-xr-x 2 root root 4096 2026-04-17 09:15:02.123456789 +0000 .hive\n"
        "-rw-r--r-- 1 root root  312 2026-04-17 09:15:02.123456789 +0000 README.md\n"
        "lrwxrwxrwx 1 root root    9 2026-04-17 09:15:02.123456789 +0000 link -> target\n"
    )

    def test_parses_mixed_entries(self) -> None:
        entries, truncated = parse_ls_output(self.SAMPLE)
        assert truncated is False
        assert [e.name for e in entries] == [".hive", "README.md", "link"]
        assert [e.kind for e in entries] == ["dir", "file", "symlink"]
        assert entries[0].size == 4096
        assert entries[2].target == "target"

    def test_skips_total_summary(self) -> None:
        entries, _ = parse_ls_output("total 4\n" + self.SAMPLE.splitlines()[1] + "\n")
        assert len(entries) == 1

    def test_drops_nanoseconds_from_mtime(self) -> None:
        entries, _ = parse_ls_output(self.SAMPLE)
        assert entries[0].mtime == "2026-04-17 09:15:02"

    def test_handles_filenames_with_spaces(self) -> None:
        src = "-rw-r--r-- 1 root root 10 2026-04-17 09:15:02 +0000 my file.txt\n"
        entries, _ = parse_ls_output(src)
        assert entries[0].name == "my file.txt"

    def test_truncates_beyond_max(self) -> None:
        line = "-rw-r--r-- 1 root root 0 2026-04-17 09:15:02 +0000 f{i}.txt\n"
        many = "".join(line.replace("{i}", str(i)) for i in range(1500))
        entries, truncated = parse_ls_output(many, max_entries=1000)
        assert truncated is True
        assert len(entries) == 1000

    def test_ignores_malformed_lines(self) -> None:
        src = "total 4\ngarbage\n-rw-r--r-- 1 root root 10 2026-04-17 09:15:02 +0000 ok.txt\n"
        entries, _ = parse_ls_output(src)
        assert [e.name for e in entries] == ["ok.txt"]
