"""Tests for ``hub.services.settings_overrides`` (M10)."""

from __future__ import annotations

from pathlib import Path

from hub.services.settings_overrides import (
    MUTABLE_FIELDS,
    load_overrides,
    save_overrides,
)


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "settings.json"
    save_overrides(
        {
            "log_level": "DEBUG",
            "metrics_enabled": False,
        },
        path=target,
    )
    loaded = load_overrides(path=target)
    assert loaded == {"log_level": "DEBUG", "metrics_enabled": False}


def test_non_mutable_keys_are_dropped_on_save(tmp_path: Path) -> None:
    target = tmp_path / "settings.json"
    save_overrides({"host": "1.2.3.4", "log_level": "WARNING"}, path=target)
    loaded = load_overrides(path=target)
    assert "host" not in loaded
    assert loaded["log_level"] == "WARNING"


def test_missing_file_returns_empty(tmp_path: Path) -> None:
    assert load_overrides(path=tmp_path / "does-not-exist.json") == {}


def test_corrupt_file_returns_empty(tmp_path: Path) -> None:
    target = tmp_path / "settings.json"
    target.write_text("{not valid json")
    assert load_overrides(path=target) == {}


def test_mutable_fields_is_the_expected_set() -> None:
    # Freeze the mutable surface so a future contributor doesn't
    # accidentally add a read-only field to the mutator list.
    assert frozenset({"log_level", "discover_roots", "metrics_enabled"}) == MUTABLE_FIELDS
