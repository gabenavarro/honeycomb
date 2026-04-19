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
