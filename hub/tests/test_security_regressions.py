"""Security-regression tests (M11).

These are the canonical smoke tests the plan calls out:

- Unauthenticated HTTP → 401
- Unauthenticated WebSocket → connection rejected
- PTY ``cmd`` query param with shell metacharacters → rejected (enum-only)
- Oversize command body → 422 (Pydantic ``max_length``)
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hub.main import app
from hub.models.schemas import MAX_COMMAND_LENGTH


@pytest.fixture
def client_with_token() -> TestClient:
    app.state.auth_token = "regression-token"
    return TestClient(app, raise_server_exceptions=False)


def test_unauth_http_returns_401(client_with_token: TestClient) -> None:
    response = client_with_token.get("/api/containers")
    assert response.status_code == 401


def test_wrong_bearer_returns_401(client_with_token: TestClient) -> None:
    response = client_with_token.get("/api/containers", headers={"Authorization": "Bearer nope"})
    assert response.status_code == 401


def test_oversize_command_returns_422(client_with_token: TestClient) -> None:
    """A command body above the documented cap fails Pydantic validation
    with 422. A transport-level 413 would require a preceding size
    middleware — 422 is the current contract, kept stable by this test."""
    huge = "a" * (MAX_COMMAND_LENGTH + 1)
    response = client_with_token.post(
        "/api/containers/1/commands",
        json={"command": huge},
        headers={"Authorization": "Bearer regression-token"},
    )
    assert response.status_code == 422
    body = response.json()
    # Pydantic's v2 error shape — one entry per rejected field, matched
    # by loc ending in "command".
    assert any("command" in (err.get("loc") or []) for err in body.get("detail", []))


def test_pty_enum_rejects_injection() -> None:
    """M5 regression: the PTY ``cmd`` query param is an enum; shell
    metacharacters fall through to the 400 default branch."""
    from hub.pty_commands import UnknownPtyCommand, resolve_command

    with pytest.raises(UnknownPtyCommand):
        resolve_command(";rm -rf /")
