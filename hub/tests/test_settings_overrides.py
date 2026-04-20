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
    assert (
        frozenset({"log_level", "discover_roots", "metrics_enabled", "timeline_visible"})
        == MUTABLE_FIELDS
    )


def test_timeline_visible_appears_in_mutable_fields() -> None:
    """M25 — timeline_visible must be declared mutable so the
    SettingsView can render it as a toggle."""
    assert "timeline_visible" in MUTABLE_FIELDS


def test_timeline_visible_default_is_true() -> None:
    """M25 — HiveSettings must default timeline_visible to True."""
    from hub.config import HiveSettings

    settings = HiveSettings()
    assert settings.timeline_visible is True


def test_timeline_visible_patch_round_trips(tmp_path) -> None:
    """M25 — save/load round-trips the flag; non-default value is preserved."""
    target = tmp_path / "settings.json"
    save_overrides({"timeline_visible": False}, path=target)
    loaded = load_overrides(path=target)
    assert loaded["timeline_visible"] is False
    # Flip back.
    save_overrides({"timeline_visible": True}, path=target)
    assert load_overrides(path=target)["timeline_visible"] is True
