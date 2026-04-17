"""Tests for ``hub.services.keybindings`` (M10)."""

from __future__ import annotations

from pathlib import Path

from hub.services.keybindings import load_keybindings, save_keybindings


def test_save_and_load_round_trip(tmp_path: Path) -> None:
    target = tmp_path / "kb.json"
    save_keybindings({"toggle-sidebar": "Ctrl+B", "command-palette": "Ctrl+K"}, path=target)
    loaded = load_keybindings(path=target)
    assert loaded == {"toggle-sidebar": "Ctrl+B", "command-palette": "Ctrl+K"}


def test_empty_values_are_dropped(tmp_path: Path) -> None:
    """An empty-string value signals 'reset to default' — drop it on save."""
    target = tmp_path / "kb.json"
    save_keybindings({"a": "Ctrl+A", "b": ""}, path=target)
    loaded = load_keybindings(path=target)
    assert loaded == {"a": "Ctrl+A"}


def test_missing_file_returns_empty(tmp_path: Path) -> None:
    assert load_keybindings(path=tmp_path / "missing.json") == {}


def test_corrupt_file_returns_empty(tmp_path: Path) -> None:
    target = tmp_path / "kb.json"
    target.write_text("not json at all")
    assert load_keybindings(path=target) == {}


def test_non_dict_file_returns_empty(tmp_path: Path) -> None:
    target = tmp_path / "kb.json"
    target.write_text('["a", "b"]')
    assert load_keybindings(path=target) == {}
