"""Tests for hub/config.py (HiveSettings)."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from hub.config import DEFAULT_DISCOVER_ROOT_CANDIDATES, HiveSettings, get_settings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip HIVE_* vars before each test so the default path is deterministic."""
    for key in [
        "HIVE_HOST",
        "HIVE_PORT",
        "HIVE_DB_PATH",
        "HIVE_DISCOVER_ROOTS",
        "HIVE_AUTH_TOKEN",
        "HIVE_LOG_LEVEL",
        "HIVE_LOG_FORMAT",
        "HIVE_METRICS_ENABLED",
    ]:
        monkeypatch.delenv(key, raising=False)
    # Ensure .env next to tests doesn't contaminate default assertions.
    monkeypatch.chdir(Path(__file__).resolve().parent)


def test_defaults_match_documented_values() -> None:
    s = HiveSettings()
    assert s.host == "127.0.0.1"
    assert s.port == 8420
    assert s.db_path == Path.home() / ".claude-hive" / "registry.db"
    assert s.discover_roots == list(DEFAULT_DISCOVER_ROOT_CANDIDATES)
    assert s.auth_token is None
    assert s.log_level == "INFO"
    assert s.log_format == "auto"
    assert s.metrics_enabled is True


def test_host_port_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIVE_HOST", "0.0.0.0")
    monkeypatch.setenv("HIVE_PORT", "9000")
    s = HiveSettings()
    assert s.host == "0.0.0.0"
    assert s.port == 9000


def test_port_out_of_range_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIVE_PORT", "70000")
    with pytest.raises(ValidationError):
        HiveSettings()


def test_discover_roots_colon_split(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIVE_DISCOVER_ROOTS", "~/foo:~/bar:~/baz")
    s = HiveSettings()
    assert s.discover_roots == ["~/foo", "~/bar", "~/baz"]


def test_discover_roots_json_form(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIVE_DISCOVER_ROOTS", '["/one", "/two"]')
    s = HiveSettings()
    assert s.discover_roots == ["/one", "/two"]


def test_discover_roots_empty_string_falls_back_to_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HIVE_DISCOVER_ROOTS", "")
    s = HiveSettings()
    assert s.discover_roots == list(DEFAULT_DISCOVER_ROOT_CANDIDATES)


def test_log_level_enum_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIVE_LOG_LEVEL", "TRACE")
    with pytest.raises(ValidationError):
        HiveSettings()


def test_log_format_enum_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HIVE_LOG_FORMAT", "xml")
    with pytest.raises(ValidationError):
        HiveSettings()


def test_metrics_enabled_accepts_bools(monkeypatch: pytest.MonkeyPatch) -> None:
    for val in ("true", "1", "yes"):
        monkeypatch.setenv("HIVE_METRICS_ENABLED", val)
        assert HiveSettings().metrics_enabled is True
    for val in ("false", "0", "no"):
        monkeypatch.setenv("HIVE_METRICS_ENABLED", val)
        assert HiveSettings().metrics_enabled is False


def test_get_settings_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    from hub.config import reset_settings_cache

    reset_settings_cache()
    first = get_settings()
    second = get_settings()
    assert first is second
