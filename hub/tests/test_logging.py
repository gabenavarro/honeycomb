"""Tests for hub/logging_setup.py — request-id binding, JSON format,
and the hub-logs broadcast sink."""

from __future__ import annotations

import io
import json
import logging
from unittest.mock import patch

import structlog
from fastapi.testclient import TestClient

from hub.config import HiveSettings
from hub.logging_setup import (
    bind_request_id,
    configure_log_broadcast,
    configure_logging,
)


def _capture_stderr() -> tuple[io.StringIO, logging.Handler]:
    """Redirect the root logger to an in-memory stream."""
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    return buf, handler


def test_json_format_contains_request_id(monkeypatch) -> None:
    """bind_request_id injects request_id into structlog event dicts."""
    settings = HiveSettings(log_format="json", log_level="INFO")

    buf = io.StringIO()
    with patch("sys.stderr", buf):
        configure_logging(settings)
        bind_request_id("abc12345")
        try:
            logger = structlog.get_logger("hub.test")
            logger.info("test_event", k="v")
        finally:
            bind_request_id(None)
            # Force handlers to flush
            for h in logging.getLogger().handlers:
                h.flush()

    lines = [line for line in buf.getvalue().splitlines() if line.strip()]
    assert lines, "expected at least one log line"
    parsed = json.loads(lines[-1])
    assert parsed["request_id"] == "abc12345"
    assert parsed["event"] == "test_event"
    assert parsed["k"] == "v"
    assert parsed["level"] == "info"


def test_broadcast_sink_receives_every_event() -> None:
    settings = HiveSettings(log_format="json", log_level="INFO")
    captured: list[dict] = []

    configure_logging(settings)
    configure_log_broadcast(captured.append)
    try:
        logger = structlog.get_logger("hub.test")
        logger.info("hello_sink", user="bob")
    finally:
        configure_log_broadcast(None)

    assert any(e.get("event") == "hello_sink" and e.get("user") == "bob" for e in captured)


def test_request_id_middleware_sets_response_header(monkeypatch) -> None:
    """The FastAPI middleware must echo the request-id back to the caller."""
    monkeypatch.setenv("HIVE_DB_PATH", "/tmp/test-reqid.db")
    from hub.config import reset_settings_cache

    reset_settings_cache()
    from hub.main import app

    with TestClient(app) as client:
        resp = client.get("/api/health")
        assert resp.status_code == 200
        rid = resp.headers.get("X-Request-ID")
        assert rid and len(rid) >= 8

        resp2 = client.get("/api/health", headers={"X-Request-ID": "inbound-id"})
        assert resp2.headers["X-Request-ID"] == "inbound-id"
