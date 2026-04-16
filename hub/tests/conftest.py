"""Shared pytest configuration for hub tests.

This file does two M3-related things that every test needs:

1. Sets ``HIVE_AUTH_TOKEN`` to a known value before the hub is imported
   and resets the :func:`hub.config.get_settings` cache. Any test that
   instantiates :class:`HiveSettings` or triggers the hub's lifespan
   gets the same predictable token.
2. Seeds ``app.state.auth_token`` directly, because some tests build a
   :class:`TestClient` without entering the ``with`` block that runs
   the lifespan. Without this step, every request would 401.

Use :data:`HIVE_TEST_TOKEN` when you need to assert on the token value
itself; the ``auth_headers`` fixture returns a dict ready to hand to
``client.get/post(..., headers=…)``.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

HIVE_TEST_TOKEN = "test-token-m3"


@pytest.fixture(autouse=True)
def _hive_test_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> Iterator[None]:
    db_root = tmp_path_factory.mktemp("hive-db")
    monkeypatch.setenv("HIVE_AUTH_TOKEN", HIVE_TEST_TOKEN)
    monkeypatch.setenv("HIVE_DB_PATH", str(db_root / "registry.db"))
    # Tests are typically not TTYs; force JSON renderer to match the
    # production log pipeline.
    monkeypatch.setenv("HIVE_LOG_FORMAT", "json")

    from hub.config import reset_settings_cache

    reset_settings_cache()

    # Some tests construct a TestClient without entering the `with`
    # block, which means the lifespan never runs and app.state is empty.
    # Seed the token here so the auth middleware accepts HIVE_TEST_TOKEN
    # even in those cases.
    from hub.main import app

    app.state.auth_token = HIVE_TEST_TOKEN

    yield


@pytest.fixture
def auth_headers() -> dict[str, str]:
    """Convenience: bearer-header dict for manual client.get/post calls."""
    return {"Authorization": f"Bearer {HIVE_TEST_TOKEN}"}
