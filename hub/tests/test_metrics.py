"""Tests for hub/services/metrics.py and the /metrics endpoint."""

from __future__ import annotations

from fastapi.testclient import TestClient

from hub.services import metrics


def test_render_returns_text_exposition_content_type() -> None:
    body, content_type = metrics.render()
    assert b"hive_containers" in body
    assert content_type.startswith("text/plain")


def test_set_container_status_counts_zeroes_absent_statuses() -> None:
    metrics.set_container_status_counts({"running": 3, "stopped": 2})
    body, _ = metrics.render()
    text = body.decode()
    assert 'hive_containers{status="running"} 3.0' in text
    assert 'hive_containers{status="stopped"} 2.0' in text
    assert 'hive_containers{status="error"} 0.0' in text
    assert 'hive_containers{status="starting"} 0.0' in text

    # A subsequent update drops the "running" count back to zero.
    metrics.set_container_status_counts({"stopped": 5})
    body, _ = metrics.render()
    text = body.decode()
    assert 'hive_containers{status="running"} 0.0' in text
    assert 'hive_containers{status="stopped"} 5.0' in text


def test_commands_counter_by_relay_path() -> None:
    before_agent = metrics.commands_total.labels(relay_path="agent")._value.get()
    metrics.commands_total.labels(relay_path="agent").inc()
    after_agent = metrics.commands_total.labels(relay_path="agent")._value.get()
    assert after_agent == before_agent + 1


def test_metrics_endpoint_returns_200_when_enabled(monkeypatch, auth_headers) -> None:
    monkeypatch.setenv("HIVE_METRICS_ENABLED", "true")
    from hub.config import reset_settings_cache

    reset_settings_cache()

    from hub.main import app

    with TestClient(app) as client:
        resp = client.get("/metrics", headers=auth_headers)
        assert resp.status_code == 200
        assert "hive_containers" in resp.text
        assert resp.headers["content-type"].startswith("text/plain")


def test_metrics_endpoint_returns_404_when_disabled(monkeypatch, auth_headers) -> None:
    monkeypatch.setenv("HIVE_METRICS_ENABLED", "false")
    from hub.config import reset_settings_cache

    reset_settings_cache()

    from hub.main import app

    with TestClient(app) as client:
        resp = client.get("/metrics", headers=auth_headers)
        assert resp.status_code == 404


def test_metrics_endpoint_requires_auth() -> None:
    """/metrics is protected — unauthenticated access returns 401."""
    from hub.main import app

    with TestClient(app) as client:
        resp = client.get("/metrics")
        assert resp.status_code == 401
