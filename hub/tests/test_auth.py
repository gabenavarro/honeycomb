"""Tests for hub/auth.py — token resolution and the auth middleware."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hub.auth import load_or_create_token
from hub.config import HiveSettings, reset_settings_cache
from hub.tests.conftest import HIVE_TEST_TOKEN

# ── load_or_create_token ────────────────────────────────────────────


def test_env_token_wins_over_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    file = tmp_path / "config" / "honeycomb" / "token"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("from-file\n")
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))

    token, source = load_or_create_token(HiveSettings(auth_token="from-env"))
    assert (token, source) == ("from-env", "env")


def test_file_token_used_when_env_unset(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HIVE_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    file = tmp_path / "honeycomb" / "token"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("from-file\n")
    file.chmod(0o600)

    reset_settings_cache()
    settings = HiveSettings()
    token, source = load_or_create_token(settings)
    assert source == "file"
    assert token == "from-file"


def test_missing_file_generates_and_persists_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("HIVE_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    reset_settings_cache()

    token, source = load_or_create_token(HiveSettings())

    file = tmp_path / "honeycomb" / "token"
    assert source == "generated"
    assert token and len(token) >= 32
    assert file.read_text().strip() == token
    # File must be user-only readable (0600).
    mode = file.stat().st_mode & 0o777
    assert mode == 0o600, f"expected 0600, got {oct(mode)}"
    # The banner was printed to stdout.
    captured = capsys.readouterr().out
    assert "new auth token generated" in captured
    assert token in captured


def test_loose_file_permissions_repaired(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HIVE_AUTH_TOKEN", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    file = tmp_path / "honeycomb" / "token"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("existing\n")
    file.chmod(0o644)  # world-readable; the loader must clamp this.

    reset_settings_cache()
    load_or_create_token(HiveSettings())

    mode = file.stat().st_mode & 0o777
    assert mode == 0o600, f"expected 0600 after repair, got {oct(mode)}"


# ── HTTP auth middleware ────────────────────────────────────────────


def _client() -> TestClient:
    from hub.main import app

    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize(
    "path",
    [
        "/api/containers",
        "/api/heartbeat",
        "/api/events",
        "/api/discover",
        "/api/gitops/repos",
        "/api/auth/status",
        "/metrics",
    ],
)
def test_unauth_request_returns_401(path: str) -> None:
    """Every protected route rejects requests that lack a bearer token."""
    with _client() as client:
        # GET is enough for middleware rejection; the handler never runs.
        resp = client.get(path)
        assert resp.status_code == 401
        body = resp.json()
        assert body["error"] == "unauthorized"


def test_wrong_token_returns_401(auth_headers: dict[str, str]) -> None:
    with _client() as client:
        resp = client.get("/api/containers", headers={"Authorization": "Bearer nope"})
        assert resp.status_code == 401
        assert resp.json()["message"] == "invalid bearer token"


def test_malformed_authorization_returns_401() -> None:
    with _client() as client:
        resp = client.get("/api/containers", headers={"Authorization": "not-a-bearer"})
        assert resp.status_code == 401


def test_correct_token_passes(auth_headers: dict[str, str]) -> None:
    with _client() as client:
        resp = client.get("/api/containers", headers=auth_headers)
        # The handler itself may 500 on a missing registry in this fixture
        # context, but middleware lets the request through — that's what
        # we're asserting here.
        assert resp.status_code != 401


def test_health_is_unauthenticated() -> None:
    """/api/health is the one protected-by-obscurity endpoint — must stay unauth."""
    with _client() as client:
        resp = client.get("/api/health")
        assert resp.status_code == 200


def test_openapi_is_unauthenticated() -> None:
    """OpenAPI docs are also exempt (useful for dev tooling)."""
    with _client() as client:
        resp = client.get("/openapi.json")
        assert resp.status_code == 200


def test_401_response_carries_www_authenticate_header() -> None:
    with _client() as client:
        resp = client.get("/api/containers")
        assert resp.status_code == 401
        assert resp.headers.get("www-authenticate", "").startswith("Bearer")


# ── WebSocket auth ──────────────────────────────────────────────────


def test_ws_without_token_is_closed() -> None:
    """The multiplex /ws refuses connections missing ?token=…"""
    with _client() as client, client.websocket_connect("/ws") as ws:
        # The server calls accept() + sends "sclosed:unauthorized" +
        # close(1008) before the handler runs. The test client
        # receives the close-reason frame before raising.
        msg = ws.receive_text()
        assert msg.startswith("sclosed")
        assert "unauthorized" in msg


def test_ws_with_token_is_accepted() -> None:
    """Supplying the correct token lets the WebSocket through."""
    with _client() as client, client.websocket_connect(f"/ws?token={HIVE_TEST_TOKEN}") as ws:
        # First server frame is the welcome packet.
        msg = ws.receive_json()
        assert msg["channel"] == "system"
        assert msg["event"] == "connected"
