"""Integration tests for /api/settings (M10)."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from hub.config import HiveSettings
from hub.services.settings_overrides import overrides_path


@pytest.fixture
def isolated_overrides(monkeypatch, tmp_path):
    """Redirect the overrides file to a temp location so tests don't
    touch ``~/.config/honeycomb/settings.json``."""
    target = tmp_path / "settings.json"
    monkeypatch.setattr(
        "hub.services.settings_overrides.overrides_path",
        lambda: target,
    )
    yield target


async def _client(monkeypatch) -> AsyncClient:
    """Build a test client with a live app, auth disabled."""
    from hub.main import app

    app.state.settings = HiveSettings()
    app.state.auth_token = "test-token"
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_get_settings_returns_mutable_fields(monkeypatch):
    client = await _client(monkeypatch)
    async with client:
        response = await client.get("/api/settings", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    body = response.json()
    assert "values" in body
    assert "mutable_fields" in body
    assert set(body["mutable_fields"]) == {
        "log_level",
        "discover_roots",
        "metrics_enabled",
        "timeline_visible",
    }


@pytest.mark.asyncio
async def test_patch_rejects_non_mutable_field(monkeypatch):
    client = await _client(monkeypatch)
    async with client:
        response = await client.patch(
            "/api/settings",
            json={"host": "1.2.3.4"},
            headers={"Authorization": "Bearer test-token"},
        )
    # extra='forbid' in the Pydantic model yields 422.
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_patch_updates_log_level(monkeypatch, isolated_overrides):
    client = await _client(monkeypatch)
    async with client:
        response = await client.patch(
            "/api/settings",
            json={"log_level": "WARNING"},
            headers={"Authorization": "Bearer test-token"},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["values"]["log_level"] == "WARNING"
    # Verify the override was persisted.
    assert isolated_overrides.exists()
    assert '"log_level": "WARNING"' in isolated_overrides.read_text()


@pytest.mark.asyncio
async def test_patch_with_empty_body_fails(monkeypatch):
    client = await _client(monkeypatch)
    async with client:
        response = await client.patch(
            "/api/settings",
            json={},
            headers={"Authorization": "Bearer test-token"},
        )
    assert response.status_code == 400


# Silence unused-import warning in environments where it's flagged.
_ = overrides_path
