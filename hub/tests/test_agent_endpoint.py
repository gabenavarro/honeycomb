"""Tests for /api/agent/connect (the reverse-tunnel entry point)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from hub.main import app
from hub.tests.conftest import HIVE_TEST_TOKEN


def test_connect_rejects_without_token() -> None:
    with TestClient(app) as client, client.websocket_connect("/api/agent/connect") as ws:
        msg = ws.receive_text()
        assert msg.startswith("sclosed")
        assert "unauthorized" in msg


def test_connect_rejects_without_container_id() -> None:
    with (
        TestClient(app) as client,
        client.websocket_connect(f"/api/agent/connect?token={HIVE_TEST_TOKEN}") as ws,
    ):
        msg = ws.receive_text()
        assert "missing-container-id" in msg


def test_connect_accepts_and_registers_agent() -> None:
    """Agent dial-in: the hub accepts the upgrade and puts the connection
    into the :class:`AgentRegistry` so the commands router can see it.

    Deregistration on close is a separate lifecycle event owned by the
    handler's ``finally`` block — its timing depends on Starlette's
    thread bridge inside :class:`TestClient` and is flaky to assert on
    here. Lifecycle teardown is covered directly by the AgentRegistry
    unit tests (``test_close_fails_in_flight_commands``,
    ``test_close_all_closes_every_connection``).
    """
    container_id = f"ctest-{id(object())}"
    with TestClient(app) as client:
        agent_registry = client.app.state.agent_registry  # type: ignore[attr-defined]
        assert agent_registry.has_live_connection(container_id) is False

        with client.websocket_connect(
            f"/api/agent/connect?token={HIVE_TEST_TOKEN}&container={container_id}"
        ) as ws:
            assert agent_registry.has_live_connection(container_id) is True
            ws.send_json(
                {
                    "type": "hello",
                    "container_id": container_id,
                    "agent_version": "test",
                    "started_at": "2026-04-16T00:00:00+00:00",
                }
            )


def test_heartbeat_updates_registry_status(tmp_path) -> None:
    """Heartbeat frames update the container's agent_status column."""
    # Per-test DB so pre-existing rows from a prior run don't collide
    # with this test's workspace INSERT.
    import os

    from hub.services.registry import Registry

    os.environ["HIVE_DB_PATH"] = str(tmp_path / "registry.db")
    from hub.config import reset_settings_cache

    reset_settings_cache()

    workspace = str(tmp_path / "ws-heartbeat")
    container_id = f"hbid-{id(object())}"

    with TestClient(app) as client:
        reg: Registry = client.app.state.registry  # type: ignore[attr-defined]

        import asyncio

        async def seed() -> None:
            from hub.models.schemas import ProjectType

            await reg.add(
                workspace_folder=workspace,
                project_type=ProjectType.BASE,
                project_name="heartbeat-test",
                project_description="",
            )
            rec = await reg.get_by_workspace(workspace)
            assert rec is not None
            await reg.update(rec.id, container_id=container_id)

        asyncio.run(seed())

        with client.websocket_connect(
            f"/api/agent/connect?token={HIVE_TEST_TOKEN}&container={container_id}"
        ) as ws:
            ws.send_json(
                {
                    "type": "heartbeat",
                    "container_id": container_id,
                    "status": "busy",
                    "session_info": {},
                }
            )
            import time

            # Poll the registry column until the handler finishes
            # processing the heartbeat.
            deadline = time.monotonic() + 1.0
            status: str | None = None

            async def _read_status() -> str | None:
                rec = await reg.get_by_container_id(container_id)
                return rec.agent_status.value if rec else None

            while time.monotonic() < deadline:
                status = asyncio.run(_read_status())
                if status == "busy":
                    break
                time.sleep(0.02)
            assert status == "busy"
